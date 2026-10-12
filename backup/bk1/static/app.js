const $ = id => document.getElementById(id);

const api = async (url, options = {}) => {
  const r = await fetch(url, options);
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(errText.trim() || r.statusText);
  }
  return r.status === 204 ? null : r.json();
};

const COLORS = {
  title: '#d97706', section: '#b45309', text: '#2563eb', list: '#0891b2', caption: '#c026d3',
  footnote: '#ea580c', aside_text: '#4f46e5',
  header: '#78716c', footer: '#78716c', page_number: '#57534e',
  table: '#dc2626', chart: '#db2777', formula: '#0d9488', code: '#16a34a', image: '#7c3aed',
};
const colorOf = label => COLORS[label] || '#9ca3af';

const state = {
  runs: [],
  jobs: [],
  run: null,
  page: 0,
  zoom: 1,
  raw: false,
  hidden: new Set(),
  file: null,
  follow: null,
  grounding: true,
  serving: null,
};

async function refreshSidebar() {
  try {
    const [runs, jobs] = await Promise.all([api('/api/runs'), api('/api/jobs')]);
    state.runs = runs || [];
    state.jobs = jobs || [];
    renderSidebar();
    if (state.jobs.some(j => j.status === 'running')) watchJobs();
  } catch (err) {
    console.error('Error refreshing sidebar:', err);
  }
}

function renderSidebar() {
  const jobs = state.jobs.filter(j => j.status !== 'done');
  const runs = state.runs.filter(r => !jobs.some(j => j.name === r.name));
  const runsCount = $('runs-count');
  if (runsCount) runsCount.textContent = runs.length ? String(runs.length) : '';
  const nav = $('runs');
  if (!nav) return;
  nav.replaceChildren(...jobs.map(jobRow), ...runs.map(runRow));
  if (!nav.children.length) nav.innerHTML = '<div class="hint">No runs yet.</div>';
}

function runRow(run) {
  const row = document.createElement('a');
  row.className = 'run' + (state.run && state.run.name === run.name ? ' current' : '');
  row.href = '#' + encodeURIComponent(run.name);
  row.innerHTML = '<span class="run-name"></span><span class="run-meta"><i></i><span></span></span><button type="button" class="delete" title="Delete this run" aria-label="Delete">×</button>';
  row.querySelector('.run-name').textContent = run.name;
  row.querySelector('.run-name').title = run.title || run.name;
  row.querySelector('i').style.setProperty('--c', run.mode === 'grounding' ? COLORS.text : COLORS.page_number);
  row.querySelector('.run-meta span').textContent = `${run.mode} · ${run.page_count} page${run.page_count === 1 ? '' : 's'} · ${when(run.modified)}`;
  row.querySelector('.delete').onclick = e => { e.preventDefault(); deleteRun(e.target, run.name); };
  return row;
}

function jobRow(job) {
  const row = document.createElement('div');
  row.className = `run job ${job.status}`;
  row.innerHTML = '<span class="run-name"></span><span class="run-meta"><span></span></span><progress max="100"></progress><button type="button" class="delete" aria-label="Dismiss">×</button>';
  row.querySelector('.run-name').textContent = job.name;
  row.querySelector('.run-meta span').textContent = job.status === 'error' ? job.error : job.total ? `${job.done} / ${job.total} pages` : 'Rendering pages…';
  row.querySelector('progress').value = job.total ? Math.round(100 * job.done / job.total) : 0;
  if (job.status === 'error') {
    row.querySelector('progress').remove();
    row.querySelector('.delete').onclick = () => api('/api/jobs/' + job.id, {method: 'DELETE'}).then(refreshSidebar).catch(toast);
  } else {
    row.querySelector('.delete').remove();
  }
  return row;
}

function deleteRun(button, name) {
  if (!button.classList.contains('armed')) {
    button.classList.add('armed');
    button.textContent = 'Delete?';
    setTimeout(() => { button.classList.remove('armed'); button.textContent = '×'; }, 3000);
    return;
  }
  api('/api/runs/' + encodeURIComponent(name), {method: 'DELETE'})
    .then(() => { if (state.run && state.run.name === name) closeRun(); return refreshSidebar(); })
    .catch(toast);
}

function when(seconds) {
  if (!seconds) return 'just now';
  const age = Date.now() / 1000 - seconds;
  if (age < 60) return 'just now';
  if (age < 3600) return `${Math.floor(age / 60)} min ago`;
  if (age < 86400) return `${Math.floor(age / 3600)} h ago`;
  if (age < 7 * 86400) return `${Math.floor(age / 86400)} d ago`;
  return new Date(seconds * 1000).toLocaleDateString(undefined, {dateStyle: 'medium'});
}

let poller = null;
function watchJobs() {
  if (poller) return;
  poller = setInterval(async () => {
    const wasRunning = new Set(state.jobs.filter(j => j.status === 'running').map(j => j.id));
    try { state.jobs = await api('/api/jobs'); } catch (e) { return; }
    const finished = state.jobs.filter(j => wasRunning.has(j.id) && j.status === 'done');
    if (finished.length) state.runs = await api('/api/runs');
    renderSidebar();
    const followed = finished.find(j => j.id === state.follow);
    if (followed) { state.follow = null; openRun(followed.name).catch(toast); }
    if (!state.jobs.some(j => j.status === 'running')) { clearInterval(poller); poller = null; }
  }, 800);
}

async function openRun(name) {
  try {
    const run = await api('/api/runs/' + encodeURIComponent(name));
    Object.assign(state, {run, page: 0, zoom: 1, raw: false});
    state.hidden.clear();
    const leftPane = $('left');
    const rightPane = $('right');
    if (leftPane) leftPane.scrollTop = 0;
    if (rightPane) rightPane.scrollTop = 0;
    if (decodeURIComponent(location.hash.slice(1)) !== name) history.replaceState(null, '', '#' + encodeURIComponent(name));
    document.body.classList.remove('menu-open');
    renderSidebar();
    renderViewer();
  } catch (err) {
    toast(err);
  }
}

function closeRun() {
  state.run = null;
  history.replaceState(null, '', location.pathname);
  renderSidebar();
  renderViewer();
}

function renderViewer() {
  const run = state.run;
  document.title = run ? `${run.name} · DotsMOCR` : 'DotsMOCR';
  const toolbar = document.querySelector('.toolbar');
  if (toolbar) toolbar.classList.toggle('idle', !run);
  
  if ($('title'))$('title').textContent = run ? run.title : '';
  if ($('mode'))$('mode').textContent = run ? (run.prompt_mode || run.mode) : '';
  if ($('viewer'))$('viewer').hidden = !run;
  if ($('empty'))$('empty').hidden = !!run;
  if (!run || !run.pages || !run.pages.length) return;

  const pages = run.pages;
  const p = pages[state.page];
  if (!p) return;

  if ($('raw'))$('raw').setAttribute('aria-pressed', String(state.raw));
  if ($('pageno'))$('pageno').value = p.page;
  if ($('count'))$('count').textContent = `/ ${pages.length}`;
  if ($('prev'))$('prev').disabled = state.page === 0;
  if ($('next'))$('next').disabled = state.page === pages.length - 1;
  if ($('img'))$('img').src = p.image;
  
  fitPage();

  const page = $('page');
  const panel = $('panel');
  if (page) page.querySelectorAll('.box').forEach(box => box.remove());
  if ($('filters'))$('filters').replaceChildren();
  if (panel) panel.replaceChildren();
  spy.disconnect();

  if (state.raw && panel) {
    const pre = document.createElement('pre');
    pre.className = 'raw';
    pre.textContent = p.raw || '';
    panel.appendChild(pre);
  }

  if (run.mode === 'grounding' && p.blocks && page && panel) {
    renderFilters(p.blocks);
    let shown = 0;
    p.blocks.forEach((block, i) => {
      if (state.hidden.has(block.label)) return;
      shown++;
      const [x1, y1, x2, y2] = block.bbox;
      const c = colorOf(block.label);
      const label = block.label;
      const box = document.createElement('div');
      box.className = 'box';
      box.dataset.i = i;
      box.dataset.label = label;
      box.style.cssText = `--c:${c};left:${x1 / 10}%;top:${y1 / 10}%;width:${(x2 - x1) / 10}%;height:${(y2 - y1) / 10}%`;
      page.appendChild(box);
      if (state.raw) return;
      const card = document.createElement('div');
      card.className = 'blk';
      card.dataset.i = i;
      card.style.setProperty('--c', c);
      card.innerHTML = `<div class="meta"><span class="lab">${label}</span><span class="bbox">${block.bbox.join(', ')}</span></div>`;
      card.appendChild(renderMarkdown(block.text || ''));
      panel.appendChild(card);
      spy.observe(card);
    });
    if (!shown && !state.raw) panel.innerHTML = '<div class="empty">No blocks on this page</div>';
  } else if (!state.raw && panel) {
    const doc = document.createElement('div');
    doc.className = 'doc';
    if (p.raw) doc.appendChild(renderMarkdown(p.raw)); else doc.innerHTML = '<div class="empty">Empty output</div>';
    panel.appendChild(doc);
  }
}

function fitPage() {
  if (!state.run) return;
  const pane = $('left');
  const p = state.run.pages[state.page];
  if (!pane || !p) return;
  const pad = 50;
  const scale = Math.min((pane.clientWidth - pad) / (p.width || 1000), (pane.clientHeight - pad) / (p.height || 1000));
  const page = $('page');
  if (page) page.style.width = Math.max(80, Math.floor((p.width || 1000) * scale * state.zoom)) + 'px';
  if ($('zoom-fit')) $('zoom-fit').textContent = state.zoom === 1 ? 'Fit' : state.zoom.toFixed(2).replace(/\.?0+$/, '') + '×';
  if ($('zoom-out'))$('zoom-out').disabled = state.zoom <= 1;
  if ($('zoom-in'))$('zoom-in').disabled = state.zoom >= 4;
}

function setZoom(zoom) {
  state.zoom = Math.min(4, Math.max(1, zoom));
  fitPage();
}

function goTo(index) {
  const pages = state.run ? state.run.pages : [];
  if (index < 0 || index >= pages.length || index === state.page) return;
  state.page = index;
  const leftPane = $('left');
  const rightPane = $('right');
  if (leftPane) leftPane.scrollTop = 0;
  if (rightPane) rightPane.scrollTop = 0;
  renderViewer();
}

function renderFilters(blocks) {
  const counts = {};
  blocks.forEach(block => { counts[block.label] = (counts[block.label] || 0) + 1; });
  const filters = $('filters');
  if (!filters) return;
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([label, n]) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.setProperty('--c', colorOf(label));
    chip.setAttribute('aria-pressed', String(!state.hidden.has(label)));
    chip.title = 'Click to hide/show';
    chip.innerHTML = `<i></i>${label} <b>${n}</b>`;
    chip.onclick = () => { state.hidden.has(label) ? state.hidden.delete(label) : state.hidden.add(label); renderViewer(); };
    filters.appendChild(chip);
  });
}

const boldCells = text => text.replace(/<(td|th)([^>]*)>([^<]*)<\/\1>/g,
  (m, tag, attrs, inner) => `<${tag}${attrs}>${inner.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')}</${tag}>`);

function renderMarkdown(text) {
  const el = document.createElement('div');
  el.className = 'md';
  try {
    if (typeof marked !== 'undefined') {
      el.innerHTML = marked.parse(boldCells(text));
    } else {
      el.textContent = text;
    }
  } catch (e) {
    el.textContent = text;
  }
  try {
    if (typeof renderMathInElement !== 'undefined') {
      renderMathInElement(el, {
        delimiters: [
          {left: '$$', right: '$$', display: true}, {left: '[', right: ']', display: true},
          {left: '$', right: '$', display: false}, {left: '\\(', right: '\\)', display: false},
        ],
        throwOnError: false,
      });
    }
  } catch (e) {}
  return el;
}

const spy = new IntersectionObserver(entries => entries.forEach(entry => {
  const page = $('page');
  if (!page) return;
  const box = page.querySelector(`.box[data-i="${entry.target.dataset.i}"]`);
  if (box) box.classList.toggle('inview', entry.isIntersecting);
}), {root: document.getElementById('right'), threshold: 0.3});

const linked = i => document.querySelectorAll(`[data-i="${i}"]`);
document.addEventListener('mouseover', e => {
  const t = e.target.closest('[data-i]');
  if (t) linked(t.dataset.i).forEach(el => el.classList.add('on'));
});
document.addEventListener('mouseout', e => {
  const t = e.target.closest('[data-i]');
  if (t) linked(t.dataset.i).forEach(el => el.classList.remove('on'));
});
document.addEventListener('click', e => {
  const t = e.target.closest('[data-i]');
  if (t) linked(t.dataset.i).forEach(el => { if (el !== t) el.scrollIntoView({block: 'center', behavior: 'smooth'}); });
});

if ($('prev'))$('prev').onclick = () => goTo(state.page - 1);
if ($('next'))$('next').onclick = () => goTo(state.page + 1);
if ($('pageno'))$('pageno').onchange = () => {
  const n = Number($('pageno').value), pages = state.run ? state.run.pages : [];
  if (!pages.length) return;
  let best = 0;
  pages.forEach((p, i) => { if (Math.abs(p.page - n) < Math.abs(pages[best].page - n)) best = i; });
  goTo(best);
  $('pageno').value = pages[state.page].page;
  $('pageno').blur();
};
if ($('zoom-in'))$('zoom-in').onclick = () => setZoom(state.zoom * 1.25);
if ($('zoom-out'))$('zoom-out').onclick = () => setZoom(state.zoom / 1.25);
if ($('zoom-fit'))$('zoom-fit').onclick = () => setZoom(1);
if ($('raw'))$('raw').onclick = () => { state.raw = !state.raw; renderViewer(); };
if ($('menu'))$('menu').onclick = () => document.body.classList.toggle('menu-open');
window.addEventListener('resize', fitPage);

document.addEventListener('keydown', e => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.metaKey || e.ctrlKey || document.querySelector('dialog[open]')) return;
  if (e.key === 'n') openNewRun();
  if (!state.run) return;
  if (e.key === 'ArrowLeft') goTo(state.page - 1);
  else if (e.key === 'ArrowRight') goTo(state.page + 1);
  else if (e.key === 'r' && $('raw'))$('raw').click();
  else if (e.key === '+' || e.key === '=') setZoom(state.zoom * 1.25);
  else if (e.key === '-') setZoom(state.zoom / 1.25);
  else if (e.key === '0') setZoom(1);
});

function openNewRun(file = null) {
  try {
    pickFile(file);
    if ($('pages'))$('pages').value = '';
    if ($('form-error'))$('form-error').hidden = true;
    offerGrounding();
    const dlg = $('new-run-dialog');
    if (dlg) {
      dlg.showModal();
    } else {
      alert("Dialog element #new-run-dialog not found!");
    }
  } catch (err) {
    console.error("Failed to open dialog:", err);
  }
}

function pickFile(file) {
  state.file = file;
  const label = $('file-label');
  const text = $('file-text');
  if (label) label.classList.toggle('has', !!file);
  if (text) text.textContent = file ? `${file.name} · ${(file.size / 1e6).toFixed(1)} MB` : 'Choose a PDF or image…';
  if ($('name')) $('name').value = file ? file.name.replace(/\.[^.]+$/, '') : '';
}

function offerGrounding() {
  const note = $('grounding-note');
  if (note) {
    note.textContent = 'Selected prompt template will be forwarded to dots_ocr / vLLM.';
  }
}

if ($('new-run'))$('new-run').onclick = () => openNewRun();
if ($('cancel')) $('cancel').onclick = () => { const dlg =$('new-run-dialog'); if (dlg) dlg.close(); };
if ($('file')) $('file').onchange = () => pickFile($('file').files[0]);

const newRunForm = $('new-run-form');
if (newRunForm) {
  newRunForm.onsubmit = async e => {
    e.preventDefault();
    if (!state.file) { 
      if ($('file-label'))$('file-label').classList.add('has'); 
      if ($('file-text'))$('file-text').textContent = 'Pick a file first'; 
      return; 
    }
    
    const formData = new FormData();
    formData.append('file', state.file);
    const runName = $('name') ?$('name').value.trim() : '';
    formData.append('name', runName || state.file.name.replace(/\.[^.]+$/, ''));
    const modeSelect = $('prompt-mode');
    formData.append('mode', modeSelect ? modeSelect.value : 'prompt_layout_all_en');

    const submitBtn = $('submit');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const job = await api('/api/runs', { method: 'POST', body: formData });
      state.follow = job.id;
      const dlg = $('new-run-dialog');
      if (dlg) dlg.close();
      await refreshSidebar();
    } catch (err) {
      if ($('form-error')) {$('form-error').textContent = err.message;
        $('form-error').hidden = false;
      }
    }
    if (submitBtn) submitBtn.disabled = false;
  };
}

const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
let dragDepth = 0;
window.addEventListener('dragenter', e => { 
  if (hasFiles(e)) { 
    dragDepth++; 
    if ($('dropzone'))$('dropzone').hidden = false; 
  } 
});
window.addEventListener('dragleave', e => { 
  if (hasFiles(e) && --dragDepth <= 0) { 
    dragDepth = 0; 
    if ($('dropzone'))$('dropzone').hidden = true; 
  } 
});
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  if ($('dropzone'))$('dropzone').hidden = true;
  if (e.dataTransfer.files[0]) openNewRun(e.dataTransfer.files[0]);
});

function renderEndpoint(s) {
  if (!s) return;
  state.grounding = s.grounding !== false;
  state.serving = s.serving || 'vLLM';
  offerGrounding();
  
  const elUrl = $('endpoint-url');
  if (elUrl) {
    elUrl.textContent = (s.serving ? s.serving + ' @ ' : '') + (s.base_url || 'online');
  }
  
  const elDot = $('endpoint-dot');
  if (elDot) {
    elDot.className = 'dot ' + (s.reachable ? 'ok' : 'down');
  }
  
  const btn = $('endpoint');
  if (btn) {
    const modelsList = (s.models && Array.isArray(s.models)) ? s.models.join(', ') : 'LLM';
    btn.title = s.reachable ? ('Model server online: ' + modelsList) : ('Model server unreachable: ' + (s.error || 'error'));
  }
}

function showEndpointStatus(s) {
  const el = $('endpoint-status');
  if (!el || !s) return;
  el.className = 'status ' + (s.reachable ? 'ok' : 'down');
  const modelsList = (s.models && Array.isArray(s.models)) ? s.models.join(', ') : 'LLM';
  el.textContent = s.reachable ? ('Online, serving: ' + modelsList) : ('Unreachable: ' + (s.error || 'Server error'));
}

const probeEndpoint = () => api('/api/settings').then(s => { renderEndpoint(s); return s; });

function openSettings() {
  const statusEl = $('endpoint-status');
  if (statusEl) {
    statusEl.className = 'status';
    statusEl.textContent = 'Checking…';
  }
  const dlg = $('settings-dialog');
  if (dlg) dlg.showModal();
  probeEndpoint().then(s => { 
    if ($('base-url'))$('base-url').value = s.base_url || ''; 
    if ($('model-name'))$('model-name').value = s.model || ''; 
    showEndpointStatus(s); 
  }).catch(toast);
}

if ($('endpoint'))$('endpoint').onclick = openSettings;
if ($('settings-cancel')) $('settings-cancel').onclick = () => { const dlg =$('settings-dialog'); if (dlg) dlg.close(); };

const settingsForm = $('settings-form');
if (settingsForm) {
  settingsForm.onsubmit = async e => {
    e.preventDefault();
    const saveBtn = $('settings-save');
    if (saveBtn) saveBtn.disabled = true;
    const statusEl = $('endpoint-status');
    if (statusEl) {
      statusEl.className = 'status';
      statusEl.textContent = 'Saving…';
    }
    try {
      const body = JSON.stringify({
        base_url: $('base-url') ?$('base-url').value.trim() : '', 
        model: $('model-name') ?$('model-name').value.trim() : ''
      });
      const s = await api('/api/settings', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body});
      renderEndpoint(s);
      showEndpointStatus(s);
      if (s.reachable) {
        const dlg = $('settings-dialog');
        if (dlg) dlg.close();
      }
    } catch (err) {
      if (statusEl) {
        statusEl.className = 'status down';
        statusEl.textContent = err.message;
      }
    }
    if (saveBtn) saveBtn.disabled = false;
  };
}

let toastTimer = null;
function toast(err) {
  console.error(err);
  const toastEl = $('toast');
  if (!toastEl) return;
  toastEl.textContent = err.message || String(err);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 5000);
}

window.addEventListener('focus', () => refreshSidebar().catch(() => {}));
window.addEventListener('hashchange', () => {
  const name = decodeURIComponent(location.hash.slice(1));
  if (name && (!state.run || state.run.name !== name)) openRun(name).catch(toast);
});

async function boot() {
  api('/api/info').then(info => { 
    if ($('info'))$('info').textContent = info.out; 
    if ($('endpoint-url'))$('endpoint-url').textContent = info.base_url; 
  }).catch(() => {});
  probeEndpoint().catch(() => {});
  await refreshSidebar();
  const wanted = decodeURIComponent(location.hash.slice(1));
  if (wanted && state.runs.some(r => r.name === wanted)) await openRun(wanted);
  else if (state.runs.length) await openRun(state.runs[0].name);
  else renderViewer();
}

boot().catch(toast);