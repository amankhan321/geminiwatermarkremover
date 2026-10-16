import { cleanImage, stamp, profilesFor, ready } from './engine.js';

await ready();

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const IMG_RE = /\.(png|jpe?g|webp|avif)$/i;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// ------------------------------------------------------------------ settings
const settings = { fmt: 'auto', quality: 95, threshold: 0.35, polish: true, deepScan: true };
let settingsDirty = false;

function seg(id, key, parse = (v) => v) {
  const el = $(id);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('button', el).forEach((x) => x.classList.toggle('on', x === b));
    settings[key] = parse(b.dataset.v);
    onSettingsChanged();
  });
}
seg('#fmtSeg', 'fmt');
seg('#sensSeg', 'threshold', Number);
$('#quality').addEventListener('input', (e) => {
  settings.quality = +e.target.value;
  $('#qualVal').textContent = e.target.value;
  onSettingsChanged();
});
function sw(id, key) {
  const el = $(id);
  const flip = () => {
    settings[key] = !settings[key];
    el.classList.toggle('on', settings[key]);
    el.setAttribute('aria-checked', settings[key]);
    onSettingsChanged();
  };
  el.closest('label').addEventListener('click', (e) => { e.preventDefault(); flip(); });
  el.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } });
}
sw('#polishSw', 'polish');
sw('#scanSw', 'deepScan');

function onSettingsChanged() {
  $('#qualField').style.opacity = settings.fmt === 'image/png' ? 0.4 : 1;
  if (items.size) { settingsDirty = true; $('#reproc').classList.add('show'); }
}
$('#reproc').addEventListener('click', () => {
  settingsDirty = false;
  $('#reproc').classList.remove('show');
  for (const it of items.values()) {
    if (it.status === 'error') continue;
    resetItem(it);
    queue.push(it.id);
  }
  pump();
  renderAll();
});

// ------------------------------------------------------------------ worker pool
const THREADS = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
$('#sThreads').textContent = THREADS;
const workers = [];
const queue = [];
let workerOK = true;

function makeWorker() {
  const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  w.busy = null;
  w.onmessage = (e) => { const id = w.busy; w.busy = null; onResult(id, e.data); pump(); };
  w.onerror = (e) => {
    const id = w.busy; w.busy = null;
    if (id != null) onResult(id, { ok: false, error: e.message || 'Worker crashed' });
    pump();
  };
  return w;
}
try { for (let i = 0; i < THREADS; i++) workers.push(makeWorker()); } catch { workerOK = false; }

function outType(file) {
  if (settings.fmt !== 'auto') return settings.fmt;
  return EXT[file.type] ? file.type : 'image/png';
}
function optsFor(it) {
  const lossyIn = /jpe?g|webp/i.test(it.file.type) || /\.(jpe?g|webp)$/i.test(it.name);
  return {
    type: outType(it.file),
    quality: settings.quality / 100,
    threshold: settings.threshold,
    polish: settings.polish && lossyIn,
    deepScan: settings.deepScan,
    force: !!it.force,
  };
}

function pump() {
  for (const w of workers) {
    if (w.busy != null) continue;
    const id = queue.shift();
    if (id == null) break;
    const it = items.get(id);
    if (!it) continue;
    w.busy = id;
    it.status = 'working';
    it.t0 = performance.now();
    renderCard(it);
    w.postMessage({ id, file: it.file, opts: optsFor(it) });
  }
  if (!workerOK) mainThreadFallback();
  updateStats();
}

// Very old browsers without module workers / OffscreenCanvas.
async function mainThreadFallback() {
  const id = queue.shift();
  if (id == null) return;
  const it = items.get(id);
  it.status = 'working'; renderCard(it);
  try {
    const bmp = await createImageBitmap(it.file, { colorSpaceConversion: 'none', imageOrientation: 'from-image' });
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const o = optsFor(it);
    const res = cleanImage({ data: d.data, width: c.width, height: c.height }, o);
    let blob = null;
    if (res.status === 'processed') {
      ctx.putImageData(d, 0, 0);
      blob = await new Promise((r) => c.toBlob(r, o.type, o.quality));
    }
    onResult(id, { ok: true, res, blob, width: c.width, height: c.height });
  } catch (err) { onResult(id, { ok: false, error: err.message }); }
  setTimeout(mainThreadFallback, 0);
}

// ------------------------------------------------------------------ items
const items = new Map();
let nextId = 1;
let filter = 'all';
const stats = { times: [] };

function resetItem(it) {
  if (it.outUrl) URL.revokeObjectURL(it.outUrl);
  it.outUrl = null; it.outBlob = null; it.res = null; it.status = 'queued'; it.error = null;
}

function addFiles(files) {
  const list = [...files].filter((f) => f && (/^image\/(png|jpeg|webp|avif)$/.test(f.type) || IMG_RE.test(f.name || '')));
  if (!list.length) { toast('No supported images in that selection'); return; }
  for (const f of list) {
    const id = nextId++;
    const it = { id, file: f, name: f.name || `pasted-${id}.png`, status: 'queued', inUrl: URL.createObjectURL(f) };
    items.set(id, it);
    queue.push(id);
    $('#grid').appendChild(buildCard(it));
  }
  $('#panel').classList.add('has');
  toast(`Added ${list.length} image${list.length > 1 ? 's' : ''}`);
  pump();
  renderEmpty();
}

function onResult(id, msg) {
  const it = items.get(id);
  if (!it) return;
  if (!msg.ok) { it.status = 'error'; it.error = msg.error; }
  else {
    it.res = msg.res; it.w = msg.width; it.h = msg.height;
    if (msg.res.status === 'processed') {
      it.status = 'done';
      it.outBlob = msg.blob;
      it.outUrl = URL.createObjectURL(msg.blob);
    } else it.status = 'skipped';
    stats.times.push(performance.now() - it.t0);
  }
  renderCard(it, true);
  updateStats();
  if (modal.id === id) openModal(id);
}

// ------------------------------------------------------------------ cards
function icon(name) {
  const p = {
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    dl: '<path d="M12 4v12M6 10l6 6 6-6M4 20h16"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  }[name];
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}

function buildCard(it) {
  const el = document.createElement('div');
  el.className = 'card queued';
  el.dataset.id = it.id;
  el.innerHTML = `
    <div class="thumb">
      <img alt="" loading="lazy" decoding="async">
      <div class="ring"></div><div class="sweep"></div>
      <div class="shade"><div class="spinner"></div></div>
      <span class="badge q">QUEUED</span><span class="peek">HOLD · ORIGINAL</span>
    </div>
    <div class="meta">
      <div class="name"></div>
      <div class="sub"><span class="dims">—</span><span class="det"></span></div>
      <div class="conf"><i></i></div>
      <div class="acts">
        <button class="ib" data-a="view">${icon('eye')}<span>Compare</span></button>
        <button class="ib" data-a="dl">${icon('dl')}<span>Save</span></button>
        <button class="ib" data-a="force" hidden>${icon('bolt')}<span>Force</span></button>
        <button class="ib x" data-a="rm" aria-label="Remove">${icon('x')}</button>
      </div>
    </div>`;
  $('.name', el).textContent = it.name;
  $('.name', el).title = it.name;
  $('img', el).src = it.inUrl;
  it.el = el;
  // press-and-hold to peek at the original; quick tap opens compare
  const th = $('.thumb', el);
  let t = 0, held = false;
  th.addEventListener('pointerdown', () => {
    held = false;
    t = setTimeout(() => { held = true; if (it.outUrl) $('img', el).src = it.inUrl; }, 180);
  });
  const up = () => { clearTimeout(t); if (it.outUrl) $('img', el).src = it.outUrl; };
  th.addEventListener('pointerup', () => { up(); if (!held) openModal(it.id); });
  th.addEventListener('pointerleave', up);
  th.addEventListener('contextmenu', (e) => e.preventDefault());
  return el;
}

function renderCard(it, flash = false) {
  const el = it.el;
  if (!el) return;
  el.className = `card ${it.status}`;
  const badge = $('.badge', el);
  const img = $('img', el);
  const r = it.res;
  const map = {
    queued: ['QUEUED', 'q'], working: ['CLEANING', 'q'],
    done: ['✓ CLEAN', 'ok'], skipped: ['NO LOGO', 'warn'], error: ['FAILED', 'bad'],
  };
  const [label, cls] = map[it.status];
  badge.textContent = label;
  badge.className = `badge ${cls}`;
  if (it.w) $('.dims', el).textContent = `${it.w}×${it.h}`;
  const det = $('.det', el);
  if (it.status === 'done') {
    det.textContent = `${r.variant === 'V2' ? 'Gemini 3.5+' : 'Classic'} · ${r.size}px`;
    if (img.src !== it.outUrl) img.src = it.outUrl;
    const m = Math.min(it.w, it.h);
    const cx = r.region.x + r.region.width / 2, cy = r.region.y + r.region.height / 2;
    const ring = $('.ring', el);
    ring.style.left = `${(1 - it.w / m + cx / m) * 100}%`;
    ring.style.top = `${(1 - it.h / m + cy / m) * 100}%`;
    const d = Math.max(0.05, (r.region.width / m) * 1.7) * 100;
    ring.style.width = `max(${d}%, 22px)`;
  } else if (it.status === 'skipped') {
    det.textContent = `match ${Math.round((r.confidence || 0) * 100)}%`;
    if (img.src !== it.inUrl) img.src = it.inUrl;
  } else if (it.status === 'error') {
    det.textContent = 'could not decode';
    det.title = it.error || '';
  } else det.textContent = '';
  $('.conf i', el).style.width = r ? `${Math.round(Math.min(1, r.confidence || 0) * 100)}%` : '0';
  $('[data-a="dl"]', el).hidden = it.status !== 'done';
  $('[data-a="force"]', el).hidden = it.status !== 'skipped';
  $('[data-a="view"]', el).disabled = !(it.status === 'done' || it.status === 'skipped');
  el.style.display = filter === 'all' || filter === it.status ? '' : 'none';
  if (flash && it.status === 'done') {
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 950);
  }
}
const renderAll = () => { for (const it of items.values()) renderCard(it); renderEmpty(); };

function renderEmpty() {
  let e = $('#grid .empty');
  const visible = [...items.values()].some((it) => filter === 'all' || it.status === filter);
  if (!visible && items.size) {
    if (!e) { e = document.createElement('div'); e.className = 'empty'; $('#grid').appendChild(e); }
    e.textContent = 'Nothing here yet.';
  } else if (e) e.remove();
}

$('#grid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  const it = items.get(+b.closest('.card').dataset.id);
  if (!it) return;
  const a = b.dataset.a;
  if (a === 'view') openModal(it.id);
  else if (a === 'dl') saveBlob(it.outBlob, outName(it));
  else if (a === 'force') forceItem(it);
  else if (a === 'rm') removeItem(it);
});

function forceItem(it) {
  it.force = true;
  resetItem(it);
  queue.unshift(it.id);
  renderCard(it);
  pump();
}
function removeItem(it) {
  const qi = queue.indexOf(it.id);
  if (qi >= 0) queue.splice(qi, 1);
  URL.revokeObjectURL(it.inUrl);
  if (it.outUrl) URL.revokeObjectURL(it.outUrl);
  it.el.remove();
  items.delete(it.id);
  if (!items.size) $('#panel').classList.remove('has');
  updateStats();
  renderEmpty();
}

$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  filter = b.dataset.f;
  $$('.chip', $('#filters')).forEach((c) => c.classList.toggle('on', c === b));
  renderAll();
});

$('#clearAll').addEventListener('click', () => {
  queue.length = 0;
  for (const it of [...items.values()]) removeItem(it);
  settingsDirty = false;
  $('#reproc').classList.remove('show');
  stats.times = [];
  updateStats();
});

function updateStats() {
  const all = [...items.values()];
  const n = (s) => all.filter((x) => x.status === s).length;
  const done = n('done'), skip = n('skipped'), err = n('error');
  const finished = done + skip + err;
  $('#sTotal').textContent = all.length;
  $('#sDone').textContent = done;
  $('#sSkip').textContent = skip;
  const t = stats.times.slice(-50);
  $('#sAvg').textContent = t.length ? `${Math.round(t.reduce((a, b) => a + b, 0) / t.length)}ms` : '—';
  $('#fAll').textContent = all.length; $('#fDone').textContent = done;
  $('#fSkip').textContent = skip; $('#fErr').textContent = err;
  const pct = all.length ? finished / all.length : 0;
  $('#prog').style.width = `${pct * 100}%`;
  $('#zipBtn').disabled = $('#dockZip').disabled = done === 0;
  $('#zipCount').textContent = done ? `(${done})` : '';
  $('#ringArc').style.strokeDashoffset = 100.5 * (1 - pct);
  $('#ringPct').textContent = `${Math.round(pct * 100)}%`;
  const busy = finished < all.length;
  $('#dockMain').textContent = busy ? `Cleaning ${finished}/${all.length}…` : `${done} of ${all.length} cleaned`;
  $('#dockSub').textContent = skip || err ? `${skip} without logo${err ? ` · ${err} failed` : ''}` : busy ? `${THREADS} threads working` : 'All done';
  updateDock();
}

// ------------------------------------------------------------------ input
const fileIn = $('#fileIn'), dirIn = $('#dirIn');
$('#pickFiles').addEventListener('click', (e) => { e.stopPropagation(); fileIn.click(); });
$('#pickFolder').addEventListener('click', (e) => { e.stopPropagation(); dirIn.click(); });
$('#drop').addEventListener('click', () => fileIn.click());
$('#drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } });
fileIn.addEventListener('change', () => { addFiles(fileIn.files); fileIn.value = ''; });
dirIn.addEventListener('change', () => { addFiles(dirIn.files); dirIn.value = ''; });
$$('[data-pick]').forEach((a) => a.addEventListener('click', () => setTimeout(() => fileIn.click(), 350)));

const drop = $('#drop');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; drop.classList.add('over'); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) drop.classList.remove('over'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.classList.remove('over');
  const dt = e.dataTransfer;
  if (!dt) return;
  const entries = [...dt.items || []].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (entries.length && entries.some((en) => en.isDirectory)) {
    const files = [];
    await Promise.all(entries.map((en) => walk(en, files)));
    addFiles(files);
  } else addFiles(dt.files);
  if (window.scrollY < $('#app').offsetTop - 200) $('#app').scrollIntoView({ behavior: 'smooth' });
});
async function walk(entry, out) {
  if (entry.isFile) {
    if (IMG_RE.test(entry.name)) out.push(await new Promise((res, rej) => entry.file(res, rej)));
    return;
  }
  const reader = entry.createReader();
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    await Promise.all(batch.map((b) => walk(b, out)));
  }
}
window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) addFiles(files);
});

// ------------------------------------------------------------------ download / zip
function outName(it) {
  const base = it.name.replace(/\.[^.]+$/, '');
  const ext = EXT[it.outBlob?.type] || 'png';
  return `${base}-clean.${ext}`;
}
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function buildZip(entries) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const { name, blob } of entries) {
    const data = new Uint8Array(await blob.arrayBuffer());
    const nb = enc.encode(name);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, nb.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, nb, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, nb.length, true); ch.setUint32(42, offset, true);
    central.push(ch.buffer, nb);
    offset += 30 + nb.length + data.length;
  }
  const csize = central.reduce((s, p) => s + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, csize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
async function downloadAll() {
  const done = [...items.values()].filter((x) => x.status === 'done');
  if (!done.length) return;
  if (done.length === 1) { saveBlob(done[0].outBlob, outName(done[0])); return; }
  const used = new Map();
  const entries = done.map((it) => {
    let name = outName(it);
    const k = name.toLowerCase();
    if (used.has(k)) { const n = used.get(k) + 1; used.set(k, n); name = name.replace(/(\.[^.]+)$/, `-${n}$1`); }
    else used.set(k, 1);
    return { name, blob: it.outBlob };
  });
  toast(`Packing ${entries.length} images…`);
  const zip = await buildZip(entries);
  saveBlob(zip, `sparkless-${entries.length}-images.zip`);
}
$('#zipBtn').addEventListener('click', downloadAll);
$('#dockZip').addEventListener('click', downloadAll);

// ------------------------------------------------------------------ dock
let toolbarVisible = true;
new IntersectionObserver(([e]) => { toolbarVisible = e.isIntersecting; updateDock(); }).observe($('.toolbar'));
function updateDock() { $('#dock').classList.toggle('show', items.size > 0 && !toolbarVisible); }

// ------------------------------------------------------------------ toast
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.transition = '.3s'; t.style.opacity = 0; setTimeout(() => t.remove(), 300); }, 2400);
}

// ------------------------------------------------------------------ compare modal
const modal = { id: null, scale: 1, fit: 1, tx: 0, ty: 0, split: 0.5, zoomed: false };
const stage = $('#stage'), inner = $('#inner');

function viewable() { return [...items.values()].filter((x) => (x.status === 'done' || x.status === 'skipped') && (filter === 'all' || filter === x.status)); }

function openModal(id) {
  const it = items.get(id);
  if (!it || !(it.status === 'done' || it.status === 'skipped')) return;
  const fresh = modal.id !== id;
  modal.id = id;
  $('#modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  $('#mName').textContent = it.name;
  const r = it.res;
  $('#mInfo').textContent = it.status === 'done'
    ? `${it.w}×${it.h} · ${r.variant === 'V2' ? 'Gemini 3.5+ layout' : 'Classic layout'} · ${r.size}px logo · ${Math.round(r.confidence * 100)}% match${r.gain !== 1 ? ` · opacity ×${r.gain}` : ''}`
    : `${it.w}×${it.h} · no sparkle found (best match ${Math.round((r.confidence || 0) * 100)}%)`;
  $('#mBefore').src = it.inUrl;
  $('#mAfter').src = it.outUrl || it.inUrl;
  $('#mDl').hidden = it.status !== 'done';
  $('#mForce').hidden = it.status !== 'skipped';
  $('#mZoom').hidden = it.status !== 'done';
  if (fresh) { modal.split = 0.5; fitView(); }
  else applyView();
}
function closeModal() {
  $('#modal').classList.remove('open');
  document.body.style.overflow = '';
  modal.id = null;
}
function fitView() {
  const it = items.get(modal.id);
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const pad = 24;
  modal.fit = Math.min((sw - pad * 2) / it.w, (sh - pad * 2) / it.h, 1.5);
  modal.scale = modal.fit;
  modal.tx = (sw - it.w * modal.scale) / 2;
  modal.ty = (sh - it.h * modal.scale) / 2;
  modal.zoomed = false;
  $('#mZoom').textContent = 'Zoom to logo';
  modal.splitX = sw * modal.split;
  applyView();
}
function applyView() {
  const it = items.get(modal.id);
  if (!it) return;
  inner.style.width = `${it.w}px`;
  inner.style.height = `${it.h}px`;
  inner.style.transform = `translate(${modal.tx}px,${modal.ty}px) scale(${modal.scale})`;
  stage.classList.toggle('px', modal.scale > 2.5);
  const sx = modal.splitX ?? stage.clientWidth / 2;
  const local = Math.max(0, Math.min(1, (sx - modal.tx) / (it.w * modal.scale)));
  $('#mAfter').style.setProperty('--s', `${local * 100}%`);
  $('#handle').style.setProperty('--s', `${sx}px`);
}
function zoomAt(px, py, factor) {
  const ns = Math.max(modal.fit * 0.5, Math.min(40, modal.scale * factor));
  modal.tx = px - ((px - modal.tx) * ns) / modal.scale;
  modal.ty = py - ((py - modal.ty) * ns) / modal.scale;
  modal.scale = ns;
  applyView();
}
function zoomToLogo() {
  const it = items.get(modal.id);
  if (!it?.res?.region) return;
  if (modal.zoomed) { fitView(); return; }
  const r = it.res.region;
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const s = Math.min(sw, sh) / (r.width * 2.6);
  modal.scale = s;
  modal.tx = sw / 2 - (r.x + r.width / 2) * s;
  modal.ty = sh / 2 - (r.y + r.height / 2) * s;
  modal.splitX = sw / 2;
  modal.zoomed = true;
  $('#mZoom').textContent = 'Fit image';
  applyView();
}
let dragging = false;
stage.addEventListener('pointerdown', (e) => { dragging = true; stage.setPointerCapture(e.pointerId); setSplit(e); });
stage.addEventListener('pointermove', (e) => { if (dragging) setSplit(e); });
stage.addEventListener('pointerup', () => { dragging = false; });
stage.addEventListener('dblclick', () => fitView());
function setSplit(e) {
  const b = stage.getBoundingClientRect();
  modal.splitX = Math.max(0, Math.min(b.width, e.clientX - b.left));
  modal.split = modal.splitX / b.width;
  applyView();
}
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const b = stage.getBoundingClientRect();
  zoomAt(e.clientX - b.left, e.clientY - b.top, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });
function step(d) {
  const list = viewable();
  const i = list.findIndex((x) => x.id === modal.id);
  const n = list[(i + d + list.length) % list.length];
  if (n) openModal(n.id);
}
$('#mClose').addEventListener('click', closeModal);
$('#mPrev').addEventListener('click', () => step(-1));
$('#mNext').addEventListener('click', () => step(1));
$('#mZoom').addEventListener('click', zoomToLogo);
$('#mDl').addEventListener('click', () => { const it = items.get(modal.id); if (it?.outBlob) saveBlob(it.outBlob, outName(it)); });
$('#mForce').addEventListener('click', () => { const it = items.get(modal.id); if (it) { forceItem(it); toast('Forcing removal…'); } });
window.addEventListener('keydown', (e) => {
  if (!$('#modal').classList.contains('open')) return;
  if (e.key === 'Escape') closeModal();
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key.toLowerCase() === 'z') zoomToLogo();
});
window.addEventListener('resize', () => { if (modal.id != null) fitView(); });

// ------------------------------------------------------------------ procedural sample art
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const PALETTES = [
  ['#120a2e', '#5b2a86', '#f0629a', '#ffd29d'],
  ['#04161f', '#0b4f6c', '#20bf55', '#e8f7c0'],
  ['#1b0b0b', '#7a1f1f', '#f2994a', '#ffe3a3'],
  ['#0a0f24', '#253a8a', '#7fb3ff', '#f4f7ff'],
  ['#0e0c1d', '#3c1f5c', '#b56cff', '#ffd6f6'],
  ['#071a14', '#0f5e4a', '#5fd3a8', '#fff1c9'],
];
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.round(v * k).toString(16).padStart(2, '0');
  return `#${f(n >> 16)}${f((n >> 8) & 255)}${f(n & 255)}`;
}
function makeArt(w, h, seed) {
  const R = rng(seed), pal = PALETTES[seed % PALETTES.length];
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, pal[0]); sky.addColorStop(0.55, pal[1]); sky.addColorStop(0.85, pal[2]);
  g.fillStyle = sky; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(255,255,255,${R() * 0.8})`; g.fillRect(R() * w, R() * h * 0.5, R() * 2 + 0.5, R() * 2 + 0.5); }
  const sx = w * (0.25 + R() * 0.5), sy = h * (0.42 + R() * 0.12), sr = Math.min(w, h) * (0.09 + R() * 0.06);
  const sun = g.createRadialGradient(sx, sy, 0, sx, sy, sr * 3.2);
  sun.addColorStop(0, pal[3]); sun.addColorStop(0.3, pal[3] + 'cc'); sun.addColorStop(1, 'transparent');
  g.fillStyle = sun; g.beginPath(); g.arc(sx, sy, sr * 3.2, 0, 7); g.fill();
  g.fillStyle = pal[3]; g.beginPath(); g.arc(sx, sy, sr, 0, 7); g.fill();
  for (let L = 0; L < 5; L++) {
    const base = h * (0.52 + L * 0.09), amp = h * (0.12 - L * 0.016);
    g.beginPath(); g.moveTo(0, h);
    let y = base - R() * amp;
    for (let x = 0; x <= w; x += w / 90) { y += (R() - 0.5) * amp * 0.35; y = Math.max(base - amp, Math.min(base, y)); g.lineTo(x, y); }
    g.lineTo(w, h); g.closePath();
    const t = L / 4;
    g.fillStyle = shade(pal[1], (1 - t) * 0.7);
    g.globalAlpha = 0.92; g.fill(); g.globalAlpha = 1;
  }
  const fog = g.createLinearGradient(0, h * 0.75, 0, h);
  fog.addColorStop(0, 'transparent'); fog.addColorStop(1, pal[2] + '55');
  g.fillStyle = fog; g.fillRect(0, h * 0.75, w, h * 0.25);
  return c;
}
function watermarkCanvas(c, profileIndex = 0) {
  const g = c.getContext('2d');
  const d = g.getImageData(0, 0, c.width, c.height);
  const p = profilesFor(c.width, c.height)[profileIndex];
  stamp(d, p.variant, p.size, c.width - p.margin - p.size, c.height - p.margin - p.size);
  g.putImageData(d, 0, 0);
  return c;
}

$('#trySample').addEventListener('click', async () => {
  const specs = [[1024, 1024, 0], [1376, 768, 0], [768, 1376, 0], [2048, 2048, 1], [1024, 1024, 1], [896, 1200, 0], [1200, 896, 'none'], [1408, 768, 0]];
  const files = [];
  let k = 0;
  for (const [w, h, p] of specs) {
    const c = makeArt(w, h, 11 + k * 7);
    if (p !== 'none') watermarkCanvas(c, p);
    const type = k % 3 === 2 ? 'image/jpeg' : 'image/png';
    const blob = await new Promise((r) => c.toBlob(r, type, 0.93));
    files.push(new File([blob], `gemini-sample-${String(++k).padStart(2, '0')}.${EXT[type]}`, { type }));
  }
  addFiles(files);
  $('#app').scrollIntoView({ behavior: 'smooth' });
});

// ------------------------------------------------------------------ hero demo
(function demo() {
  const N = 1024;
  const art = makeArt(N, N, 4);
  const ctx = art.getContext('2d');
  const clean = ctx.getImageData(0, 0, N, N);
  const wm = watermarkCanvas(makeArt(N, N, 4));
  const wmData = wm.getContext('2d').getImageData(0, 0, N, N);
  const fixed = new ImageData(new Uint8ClampedArray(wmData.data), N, N);
  const res = cleanImage({ data: fixed.data, width: N, height: N });
  const before = $('#demoBefore'), after = $('#demoAfter');
  before.width = after.width = N; before.height = after.height = N;
  before.getContext('2d').putImageData(wmData, 0, 0);
  after.getContext('2d').putImageData(fixed, 0, 0);
  let changed = 0;
  if (res.region) {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const inside = x >= res.region.x && x < res.region.x + res.region.width && y >= res.region.y && y < res.region.y + res.region.height;
      if (inside) continue;
      const i = (y * N + x) * 4;
      if (fixed.data[i] !== clean.data[i] || fixed.data[i + 1] !== clean.data[i + 1]) changed++;
    }
  }
  $('.float-chip.a b').textContent = changed;
  $('#demoVar').textContent = res.status === 'processed' ? `${res.variant === 'V2' ? '3.5+' : 'Classic'} · ${res.size}px` : '—';
  $('#demoConf').textContent = res.confidence ? `${Math.round(res.confidence * 100)}%` : '—';
  $('#demoMs').textContent = `${res.ms}ms`;

  const zoom = $('#demoZoom'), zg = zoom.getContext('2d');
  zg.imageSmoothingEnabled = false;
  const r = res.region || { x: N - 100, y: N - 100, width: 48, height: 48 };
  const pad = Math.round(r.width * 0.25), zx = r.x - pad, zy = r.y - pad, zs = r.width + pad * 2;
  const stageEl = $('#demoStage');
  let split = 0.3, userUntil = 0;
  function draw() {
    stageEl.style.setProperty('--split', `${split * 100}%`);
    const sx = split * N;
    zg.clearRect(0, 0, 120, 120);
    // left of the scan line is cleaned, right is still watermarked
    zg.drawImage(before, zx, zy, zs, zs, 0, 0, 120, 120);
    const cut = Math.max(0, Math.min(zs, sx - zx));
    if (cut > 0) zg.drawImage(after, zx, zy, cut, zs, 0, 0, (cut / zs) * 120, 120);
  }
  const t0 = performance.now();
  function tick(t) {
    if (t > userUntil) {
      const ph = ((t - t0) / 5200) % 1;
      const e = ph < 0.5 ? ph * 2 : 2 - ph * 2;
      split = 0.08 + 0.9 * (e * e * (3 - 2 * e));
    }
    draw();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  const move = (e) => {
    const b = stageEl.getBoundingClientRect();
    split = Math.max(0, Math.min(1, (e.clientX - b.left) / b.width));
    userUntil = performance.now() + 2500;
  };
  stageEl.addEventListener('pointermove', move);
  stageEl.addEventListener('pointerdown', move);
})();

updateStats();
