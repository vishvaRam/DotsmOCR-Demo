import json
import math
import os
import re
import shutil
import time
import uuid
from typing import Optional

from dots_ocr.parser import DotsOCRParser
from dots_ocr.utils.doc_utils import load_images_from_pdf
from dots_ocr.utils.prompts import dict_promptmode_to_prompt
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel

app = FastAPI(title="DotsMOCR Viewer")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(BASE_DIR, "out")
STATIC_DIR = os.path.join(BASE_DIR, "static")
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(STATIC_DIR, exist_ok=True)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

jobs = {}

# Active vLLM configuration
VLLM_CONFIG = {
    "ip": "157.157.221.29",
    "port": "25457",
    "model_name": "Vishva007/dots.mocr-W4A16-AutoRound-GPTQ",
    "dpi": 200,
    "num_thread": 6,
    "max_completion_tokens": 11384,
}

# ---------------------------------------------------------------------------
# Scene spotting settings
# ---------------------------------------------------------------------------
# Order of each point in the model output: "xy" -> (x, y), "yx" -> (y, x)
SPOT_COORD_ORDER = "xy"

# "model_pixels" -> coords are in the VLM's resized input space (recommended)
# "norm1000"     -> coords already on a 0-1000 grid
# "norm2048"     -> coords on a 0-2048 grid
SPOT_COORD_SYSTEM = "model_pixels"

SPOT_RESIZE_FACTOR = 28

# Defaults used if dots_ocr's own values cannot be imported.
FALLBACK_MIN_PIXELS = 3136
FALLBACK_MAX_PIXELS = 11289600

try:
    from dots_ocr.utils.image_utils import (
        smart_resize as dots_smart_resize,
        MIN_PIXELS as DOTS_MIN_PIXELS,
        MAX_PIXELS as DOTS_MAX_PIXELS,
    )
except Exception:
    dots_smart_resize = None
    DOTS_MIN_PIXELS = FALLBACK_MIN_PIXELS
    DOTS_MAX_PIXELS = FALLBACK_MAX_PIXELS


class SettingsUpdate(BaseModel):
    base_url: str
    model: Optional[str] = "Vishva007/dots.mocr-W4A16-AutoRound-GPTQ"


def smart_resize_fallback(height, width, factor, min_pixels, max_pixels):
    """Qwen2-VL style resize, used only if dots_ocr's version cannot be imported."""
    h_bar = max(factor, round(height / factor) * factor)
    w_bar = max(factor, round(width / factor) * factor)

    if h_bar * w_bar > max_pixels:
        beta = math.sqrt((height * width) / max_pixels)
        h_bar = max(factor, math.floor(height / beta / factor) * factor)
        w_bar = max(factor, math.floor(width / beta / factor) * factor)
    elif h_bar * w_bar < min_pixels:
        beta = math.sqrt(min_pixels / (height * width))
        h_bar = math.ceil(height * beta / factor) * factor
        w_bar = math.ceil(width * beta / factor) * factor

    return h_bar, w_bar


def get_model_input_size(img_h: int, img_w: int):
    """Returns (height, width) of the image as the VLM received it."""
    if dots_smart_resize is not None:
        try:
            h, w = dots_smart_resize(
                img_h, img_w,
                factor=SPOT_RESIZE_FACTOR,
                min_pixels=DOTS_MIN_PIXELS,
                max_pixels=DOTS_MAX_PIXELS,
            )
            return int(h), int(w)
        except TypeError:
            pass
    return smart_resize_fallback(
        img_h, img_w,
        factor=SPOT_RESIZE_FACTOR,
        min_pixels=DOTS_MIN_PIXELS,
        max_pixels=DOTS_MAX_PIXELS,
    )


def parse_scene_spotting_text(raw_text: str, img_w: int, img_h: int):
    """
    Parses dots_ocr scene spotting output:
    (p1_a, p1_b), (p2_a, p2_b), (p3_a, p3_b), (p4_a, p4_b) Extracted Text

    Returns:
      items:      list of {"text", "bbox"}, bbox = [xmin, ymin, xmax, ymax]
                  on a 0-1000 grid relative to the full page
      debug:      dict with the sizes and settings used for mapping
    """
    pattern = re.compile(
        r"\((\d+),\s*(\d+)\),\s*"
        r"\((\d+),\s*(\d+)\),\s*"
        r"\((\d+),\s*(\d+)\),\s*"
        r"\((\d+),\s*(\d+)\)"
        r"(.*?)(?=\(\d+,\s*\d+\)|$)",
        re.DOTALL,
    )

    raw_items = []
    for match in pattern.finditer(raw_text):
        groups = match.groups()
        coords = [int(v) for v in groups[:8]]
        text_clean = groups[8].strip()
        if not text_clean:
            continue

        pts = [(coords[i], coords[i + 1]) for i in range(0, 8, 2)]
        if SPOT_COORD_ORDER == "yx":
            xs = [p[1] for p in pts]
            ys = [p[0] for p in pts]
        else:
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]

        raw_items.append({
            "text": text_clean,
            "bbox": [min(xs), min(ys), max(xs), max(ys)],
        })

    debug = {
        "image_size": [img_w, img_h],
        "coord_system": SPOT_COORD_SYSTEM,
        "coord_order": SPOT_COORD_ORDER,
        "model_input_size": None,
        "max_raw_coord": None,
    }

    if not raw_items:
        return {"items": [], "debug": debug}

    debug["max_raw_coord"] = max(max(it["bbox"]) for it in raw_items)

    if SPOT_COORD_SYSTEM == "model_pixels":
        model_h, model_w = get_model_input_size(img_h, img_w)
        debug["model_input_size"] = [model_w, model_h]
        sx = 1000.0 / float(model_w)
        sy = 1000.0 / float(model_h)
    elif SPOT_COORD_SYSTEM == "norm2048":
        sx = sy = 1000.0 / 2048.0
    else:  # norm1000
        sx = sy = 1.0

    items = []
    for it in raw_items:
        xmin, ymin, xmax, ymax = it["bbox"]
        items.append({
            "text": it["text"],
            "bbox": [
                max(0, min(1000, int(round(xmin * sx)))),
                max(0, min(1000, int(round(ymin * sy)))),
                max(0, min(1000, int(round(xmax * sx)))),
                max(0, min(1000, int(round(ymax * sy)))),
            ],
        })

    return {"items": items, "debug": debug}


@app.get("/")
def get_index():
    index_path = os.path.join(BASE_DIR, "index.html")
    if not os.path.exists(index_path):
        index_path = os.path.join(STATIC_DIR, "index.html")
    return FileResponse(index_path)


@app.get("/api/info")
def get_info():
    return {
        "out": OUT_DIR,
        "base_url": f"http://{VLLM_CONFIG['ip']}:{VLLM_CONFIG['port']}/v1",
        "model": VLLM_CONFIG["model_name"],
    }


@app.get("/api/settings")
def get_settings():
    return {
        "base_url": f"http://{VLLM_CONFIG['ip']}:{VLLM_CONFIG['port']}/v1",
        "model": VLLM_CONFIG["model_name"],
        "serving": VLLM_CONFIG["model_name"],
        "reachable": True,
        "models": [VLLM_CONFIG["model_name"]],
        "grounding": True,
    }


@app.put("/api/settings")
def update_settings(cfg: SettingsUpdate):
    clean_url = (
        cfg.base_url.replace("http://", "").replace("https://", "").rstrip("/")
    )
    if "/v1" in clean_url:
        clean_url = clean_url.split("/v1")[0]

    parts = clean_url.split(":")
    if parts[0]:
        VLLM_CONFIG["ip"] = parts[0]
    if len(parts) > 1 and parts[1]:
        VLLM_CONFIG["port"] = parts[1]
    if cfg.model:
        VLLM_CONFIG["model_name"] = cfg.model
    return get_settings()


@app.get("/api/prompts")
def get_available_prompts():
    return list(dict_promptmode_to_prompt.keys())


@app.get("/api/jobs")
def list_jobs():
    return list(jobs.values())


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    if job_id in jobs:
        del jobs[job_id]
    return Response(status_code=204)


@app.get("/api/runs")
def list_runs():
    runs = []
    if not os.path.exists(OUT_DIR):
        return runs
    for name in os.listdir(OUT_DIR):
        run_folder = os.path.join(OUT_DIR, name)
        manifest = os.path.join(run_folder, "run.json")
        if os.path.isdir(run_folder) and os.path.exists(manifest):
            try:
                with open(manifest, "r", encoding="utf-8") as f:
                    runs.append(json.load(f))
            except Exception:
                continue
    runs.sort(key=lambda x: x.get("modified", 0), reverse=True)
    return runs


@app.get("/api/runs/{run_name}")
def get_run(run_name: str):
    manifest = os.path.join(OUT_DIR, run_name, "run.json")
    if not os.path.exists(manifest):
        raise HTTPException(status_code=404, detail="Run not found")
    with open(manifest, "r", encoding="utf-8") as f:
        return json.load(f)


@app.delete("/api/runs/{run_name}")
def delete_run(run_name: str):
    run_folder = os.path.join(OUT_DIR, run_name)
    if os.path.exists(run_folder):
        shutil.rmtree(run_folder)
    return Response(status_code=204)


@app.get("/files/{run_name}/{filename}")
def get_file(run_name: str, filename: str):
    file_path = os.path.join(OUT_DIR, run_name, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(file_path)


def process_dots_ocr(
    job_id: str, run_name: str, file_path: str, prompt_mode: str
):
    job = jobs[job_id]
    job["status"] = "running"
    run_dir = os.path.join(OUT_DIR, run_name)
    os.makedirs(run_dir, exist_ok=True)

    try:
        is_pdf = file_path.lower().endswith(".pdf")
        if is_pdf:
            raw_images = load_images_from_pdf(file_path, dpi=VLLM_CONFIG["dpi"])
        else:
            raw_images = [Image.open(file_path).convert("RGB")]

        parser = DotsOCRParser(
            ip=VLLM_CONFIG["ip"],
            port=VLLM_CONFIG["port"],
            model_name=VLLM_CONFIG["model_name"],
            dpi=VLLM_CONFIG["dpi"],
            max_completion_tokens=VLLM_CONFIG["max_completion_tokens"],
            num_thread=VLLM_CONFIG["num_thread"],
            output_dir=run_dir,
            use_hf=False,
        )

        results = parser.parse_file(
            input_path=file_path,
            output_dir=run_dir,
            prompt_mode=prompt_mode,
        )

        job["total"] = len(results)
        pages_payload = []

        is_layout_mode = prompt_mode in [
            "prompt_layout_all_en",
            "prompt_layout_only_en",
            "prompt_grounding_ocr",
        ]
        is_spotting_mode = prompt_mode in [
            "prompt_scene_spotting",
            "prompt_word_level_ocr",
        ]
        is_grounding = is_layout_mode or is_spotting_mode

        for idx, res in enumerate(results):
            job["done"] = idx + 1
            page_no = res.get("page_no", 0) + 1
            dst_img_name = f"page_{page_no}.png"
            dst_img_path = os.path.join(run_dir, dst_img_name)

            if idx < len(raw_images):
                img = raw_images[idx]
                img.save(dst_img_path, format="PNG")
                img_w, img_h = img.size
            else:
                src_img = res.get("layout_image_path")
                shutil.copy(src_img, dst_img_path)
                with Image.open(dst_img_path) as im:
                    img_w, img_h = im.size

            raw_text = ""
            md_path = res.get("md_content_path")
            if md_path and os.path.exists(md_path):
                with open(md_path, "r", encoding="utf-8") as f:
                    raw_text = f.read()

            blocks = []
            spot_debug = None

            # Case A: Standard Layout Detection
            # dots_ocr outputs pixel coordinates on raw_image [0..img_w, 0..img_h]
            if is_layout_mode:
                json_path = res.get("layout_info_path")
                if json_path and os.path.exists(json_path):
                    with open(json_path, "r", encoding="utf-8") as f:
                        cells = json.load(f)
                        if isinstance(cells, list):
                            for c in cells:
                                box = c.get("bbox", [0, 0, 0, 0])
                                if len(box) != 4:
                                    continue
                                x1, y1, x2, y2 = box
                                scale_x = 1000.0 / float(img_w)
                                scale_y = 1000.0 / float(img_h)

                                norm_bbox = [
                                    max(0, min(1000, int(round(min(x1, x2) * scale_x)))),
                                    max(0, min(1000, int(round(min(y1, y2) * scale_y)))),
                                    max(0, min(1000, int(round(max(x1, x2) * scale_x)))),
                                    max(0, min(1000, int(round(max(y1, y2) * scale_y)))),
                                ]

                                blocks.append({
                                    "label": str(c.get("category", "text")).lower(),
                                    "bbox": norm_bbox,
                                    "text": c.get("text", ""),
                                    "continues": False,
                                })

            # Case B: Scene Spotting & Word-Level OCR
            # Output is converted to a page-relative 0-1000 grid here
            elif is_spotting_mode:
                parsed = parse_scene_spotting_text(raw_text, img_w, img_h)
                spot_debug = parsed["debug"]
                for s in parsed["items"]:
                    blocks.append({
                        "label": "text",
                        "bbox": s["bbox"],
                        "text": s["text"],
                        "continues": False,
                    })
                print(
                    f"[spotting] page {page_no}: image={img_w}x{img_h} "
                    f"model_input={spot_debug['model_input_size']} "
                    f"max_raw_coord={spot_debug['max_raw_coord']} "
                    f"boxes={len(blocks)}"
                )

            pages_payload.append({
                "page": page_no,
                "image": f"/files/{run_name}/{dst_img_name}",
                "width": img_w,
                "height": img_h,
                "raw": raw_text,
                "blocks": blocks if is_grounding else None,
                "spotting_debug": spot_debug,
            })

        manifest = {
            "name": run_name,
            "title": os.path.basename(file_path),
            "mode": "grounding" if is_grounding else "plain",
            "prompt_mode": prompt_mode,
            "page_count": len(pages_payload),
            "modified": int(time.time()),
            "pages": pages_payload,
        }

        with open(os.path.join(run_dir, "run.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)

        job["status"] = "done"

    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)


@app.post("/api/runs")
async def create_run(
    background_tasks: BackgroundTasks,
    name: str = Form(""),
    mode: str = Form("prompt_layout_all_en"),
    file: UploadFile = File(...),
):
    if not name:
        name = os.path.splitext(file.filename)[0] + "_" + uuid.uuid4().hex[:6]

    temp_path = os.path.join(OUT_DIR, f"temp_{uuid.uuid4().hex}_{file.filename}")
    with open(temp_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        "id": job_id,
        "name": name,
        "status": "queued",
        "total": 0,
        "done": 0,
        "error": None,
    }

    background_tasks.add_task(process_dots_ocr, job_id, name, temp_path, mode)
    return jobs[job_id]


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host="0.0.0.0", port=8001, reload=True)