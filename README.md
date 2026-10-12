# DotsMOCR Viewer

A lightweight web viewer and inference interface for **dots.mocr** (`dots_ocr`), powered by a **vLLM** backend and inspired by the LightOnOCR visual interface.

This tool enables multi-page document processing for PDFs and images, featuring interactive side-by-side layout grounding, bounding-box inspection, and formatted Markdown rendering.

---

## Features

* **Interactive Layout Grounding**: Visualizes bounding boxes directly on rendered document pages with synchronized card selection, highlighting, and label filtering.
* **Flexible Prompt Support**: Full integration with `dots_ocr/utils/prompts.py` modes:
* `prompt_layout_all_en` (Full layout block detection + markdown transcription)
* `prompt_layout_only_en` (Layout bounding boxes only)
* `prompt_scene_spotting` & `prompt_word_level_ocr` (Fine-grained word and scene text spotting with polygon extraction)
* `prompt_ocr` / `prompt_markdown` (Document transcription to plain Markdown)
* **Asynchronous Execution**: Background job queuing for long multi-page PDF runs.
* **Accurate Normalization**: Scales model coordinate systems (0–1000, 2048, or resized aspect ratios) directly onto clean document canvas renders.
* **Math & Markdown Support**: Native formatting powered by `marked.js` and `KaTeX`.

---

## Project Structure

```text
DotsmOCR/
├── dots_ocr/              # Core dots.mocr package (parser, models, prompts)
├── static/
│   ├── app.css            # Dark/light adaptive interface styling
│   └── app.js             # Viewer interactions, bounding-box rendering, API polling
│   └── index.html         # Main web dashboard and run modal   
├── server.py              # FastAPI server connecting to vLLM
└── requirements.txt       # Python dependencies
```

---

## Prerequisites

* Python 3.10+
* An active **vLLM** instance serving your multimodal model (e.g., `dots.mocr` at `http://<ip>:<port>/v1`)

---

## Installation

1. **Clone the repository**:

```bash
git clone https://github.com/vishvaRam/DotsmOCR-Demo.git
cd DotsmOCR
```

2. **Install dependencies**:

```bash
pip install fastapi uvicorn pymupdf pillow pydantic requests tqdm
```

*(or use `uv sync` / `uv pip install -r requirements.txt`)*

---

## Configuration & Usage

1. **Configure Model Endpoint**:
   Ensure `server.py` points to your active vLLM instance:

```python
VLLM_CONFIG = {
    "ip": "157.157.221.29",
    "port": "25457",
    "model_name": "Vishva007/dots.mocr-W4A16-AutoRound-GPTQ",
    "dpi": 200,
    "num_thread": 6,
    "max_completion_tokens": 11384,
}
```

*(You can also configure this dynamically via the **Model server** button in the UI)*.

2. **Start the Viewer**:

```bash
python server.py
# or with uv:
uv run server.py
```

3. **Access the Interface**:
   Open `http://localhost:8001` (or your machine's local network IP) in your browser.

* Click **New run** or drag and drop a PDF/image.
* Select your target **Prompt Mode** from `prompts.py`.
* Inspect layout tags, bounding boxes, and Markdown output side-by-side.
