// Sparkless engine — detects the Gemini sparkle and reverses its alpha blend.
//
//   watermarked = a * 255 + (1 - a) * original
//   original    = (watermarked - a * 255) / (1 - a)
//
// Uses calibrated alpha maps (see alpha.js). Pure functions on RGBA buffers:
// runs the same in a Web Worker, the main thread, or Node.

import { ALPHA_LAYOUT, ALPHA_PACKED, ALPHA_SHA } from './alpha.js';

const MAX_ALPHA = 0.99;
const MIN_ALPHA = 0.002;

// ---------- alpha maps ----------
const alphaCache = new Map();
let SOURCES = null;
let readyPromise = null;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Unpack the alpha maps. Await once before calling anything else. */
export function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const stream = new Blob([b64ToBytes(ALPHA_PACKED)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const all = new Uint8Array(await new Response(stream).arrayBuffer());
      const map = {};
      let off = 0;
      for (const [key, w, h] of ALPHA_LAYOUT) { map[key] = all.subarray(off, off + w * h); off += w * h; }
      if (off !== all.length) throw new Error('alpha data corrupt');
      if (globalThis.crypto?.subtle) {
        const h = [...new Uint8Array(await crypto.subtle.digest('SHA-1', all))].map((b) => b.toString(16).padStart(2, '0')).join('');
        if (h !== ALPHA_SHA) throw new Error('alpha data checksum mismatch');
      }
      SOURCES = map;
    })();
  }
  return readyPromise;
}

function sourceAlpha(key) {
  let a = alphaCache.get(key);
  if (!a) {
    if (!SOURCES) throw new Error('engine not ready: await ready() first');
    const bytes = SOURCES[key];
    a = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) a[i] = bytes[i] / 255;
    alphaCache.set(key, a);
  }
  return a;
}

// Area-average downscale / bilinear upscale of a square map.
function resizeSquare(src, n, m) {
  if (n === m) return src;
  const out = new Float32Array(m * m);
  if (m < n) {
    const s = n / m;
    for (let dy = 0; dy < m; dy++) {
      const y0 = dy * s, y1 = y0 + s;
      for (let dx = 0; dx < m; dx++) {
        const x0 = dx * s, x1 = x0 + s;
        let sum = 0;
        for (let sy = Math.floor(y0); sy < y1 && sy < n; sy++) {
          const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
          if (wy <= 0) continue;
          for (let sx = Math.floor(x0); sx < x1 && sx < n; sx++) {
            const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
            if (wx > 0) sum += src[sy * n + sx] * wx * wy;
          }
        }
        out[dy * m + dx] = sum / (s * s);
      }
    }
  } else {
    const s = n / m;
    for (let dy = 0; dy < m; dy++) {
      let fy = Math.max(0, (dy + 0.5) * s - 0.5);
      const y0 = Math.min(n - 1, Math.floor(fy)), y1 = Math.min(n - 1, y0 + 1), wy = fy - y0;
      for (let dx = 0; dx < m; dx++) {
        let fx = Math.max(0, (dx + 0.5) * s - 0.5);
        const x0 = Math.min(n - 1, Math.floor(fx)), x1 = Math.min(n - 1, x0 + 1), wx = fx - x0;
        const t = src[y0 * n + x0] + (src[y0 * n + x1] - src[y0 * n + x0]) * wx;
        const b = src[y1 * n + x0] + (src[y1 * n + x1] - src[y1 * n + x0]) * wx;
        out[dy * m + dx] = t + (b - t) * wy;
      }
    }
  }
  return out;
}

function alphaFor(variant, size) {
  const key = `${variant}:${size}`;
  let a = alphaCache.get(key);
  if (a) return a;
  if (variant === 'V1' && size === 48) a = sourceAlpha('V1:small');
  else if (variant === 'V2' && size === 36) a = sourceAlpha('V2:small');
  else a = resizeSquare(sourceAlpha(`${variant}:large`), 96, size);
  alphaCache.set(key, a);
  return a;
}

// ---------- placement profiles ----------
const half = (v) => Math.sign(v) * Math.round(Math.abs(v));

function v2Small(w, h) {
  const long = Math.max(w, h), short = Math.min(w, h);
  let srcLong;
  if (long > 1100) {
    srcLong = 2752;
    for (const c of [2816, 2848]) if (Math.abs(2 * long - c) < Math.abs(2 * long - srcLong)) srcLong = c;
  } else if (short >= 566) srcLong = 2752;
  else if (short >= 550) srcLong = 2816;
  else srcLong = 2848;
  const k = long / srcLong;
  const ideal = half(96 * k);
  return { margin: half(192 * k), size: ideal <= 40 ? 36 : ideal };
}

/** Known placements for an image of this size, most likely first. */
export function profilesFor(w, h) {
  const large = w > 1024 && h > 1024;
  const v2 = large ? { margin: 192, size: 96 } : v2Small(w, h);
  return [
    // Fixed layouts are trusted exactly; the scaled 3.5+ small layout may sit a few px off.
    { variant: 'V2', size: v2.size, margin: v2.margin, pad: large ? 0 : 4, snap: !large },
    { variant: 'V1', size: large ? 96 : 48, margin: large ? 64 : 32, pad: 0, snap: false },
  ];
}

// ---------- image ops ----------
function grayRegion(img, x, y, w, h) {
  const { data, width } = img;
  const out = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    let p = ((y + r) * width + x) * 4;
    for (let c = 0; c < w; c++, p += 4) {
      out[r * w + c] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255;
    }
  }
  return out;
}

function sobel(src, w, h) {
  const out = new Float32Array(w * h);
  const at = (x, y) => src[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = at(x + 1, y - 1) - at(x - 1, y - 1) + 2 * (at(x + 1, y) - at(x - 1, y)) + at(x + 1, y + 1) - at(x - 1, y + 1);
      const gy = at(x - 1, y + 1) - at(x - 1, y - 1) + 2 * (at(x, y + 1) - at(x, y - 1)) + at(x + 1, y + 1) - at(x + 1, y - 1);
      out[y * w + x] = Math.hypot(gx, gy);
    }
  }
  return out;
}

function stats(t) {
  let s = 0;
  for (let i = 0; i < t.length; i++) s += t[i];
  const mean = s / t.length;
  let e = 0;
  for (let i = 0; i < t.length; i++) e += (t[i] - mean) ** 2;
  return { mean, norm: Math.sqrt(e) };
}

/**
 * Normalised cross-correlation of template t (n×n) at every offset of roi (rw×rh).
 * `ps` samples every ps-th template pixel (coarse pass); unsampled offsets stay -1.
 */
function nccMap(roi, rw, rh, t, n, ps = 1, os = 1) {
  const ow = rw - n + 1, oh = rh - n + 1;
  const out = new Float32Array(Math.max(0, ow * oh)).fill(-1);
  let cnt = 0, tsum = 0;
  for (let ty = 0; ty < n; ty += ps) for (let tx = 0; tx < n; tx += ps) { tsum += t[ty * n + tx]; cnt++; }
  const tm = tsum / cnt;
  let te = 0;
  for (let ty = 0; ty < n; ty += ps) for (let tx = 0; tx < n; tx += ps) te += (t[ty * n + tx] - tm) ** 2;
  const tn = Math.sqrt(te);
  if (tn === 0) return { map: out.fill(0), ow, oh };
  for (let oy = 0; oy < oh; oy += os) {
    for (let ox = 0; ox < ow; ox += os) {
      let sum = 0, sq = 0, cov = 0;
      for (let ty = 0; ty < n; ty += ps) {
        const row = (oy + ty) * rw + ox, trow = ty * n;
        for (let tx = 0; tx < n; tx += ps) {
          const v = roi[row + tx];
          sum += v; sq += v * v; cov += v * (t[trow + tx] - tm);
        }
      }
      const varr = sq - (sum * sum) / cnt;
      out[oy * ow + ox] = varr <= 1e-9 ? 0 : cov / (tn * Math.sqrt(varr));
    }
  }
  return { map: out, ow, oh };
}

function argmax(map, ow) {
  let best = -Infinity, at = 0;
  for (let i = 0; i < map.length; i++) if (map[i] > best) { best = map[i]; at = i; }
  return { value: best, dx: at % ow, dy: Math.floor(at / ow) };
}

// ---------- detection ----------
function scoreCandidate(img, variant, size, ex, ey, pad, coarse = false, snap = true) {
  const { width: W, height: H } = img;
  const x1 = Math.max(0, ex - pad), y1 = Math.max(0, ey - pad);
  const x2 = Math.min(W, ex + size + pad), y2 = Math.min(H, ey + size + pad);
  const rw = x2 - x1, rh = y2 - y1;
  if (rw < size || rh < size) return null;
  const alpha = alphaFor(variant, size);
  const roi = grayRegion(img, x1, y1, rw, rh);
  const step = coarse ? Math.max(1, Math.round(size / 28)) : 1;
  let best;
  if (step === 1) {
    const sp = nccMap(roi, rw, rh, alpha, size);
    best = argmax(sp.map, sp.ow);
    // Prefer the documented position unless a nearby spot is clearly a better match.
    const fx = ex - x1, fy = ey - y1;
    if (fx >= 0 && fy >= 0 && fx < sp.ow && fy < sp.oh) {
      const vf = sp.map[fy * sp.ow + fx];
      if (!snap || best.value < 0.6 || best.value < vf + 0.03) best = { value: vf, dx: fx, dy: fy };
    }
  } else {
    // Coarse pass on a sparse grid, then refine around the peak.
    const sp = nccMap(roi, rw, rh, alpha, size, step, step);
    const c = argmax(sp.map, sp.ow);
    if (c.value < 0.2) return { variant, size, x: x1 + c.dx, y: y1 + c.dy, spatial: c.value, gradient: 0, confidence: Math.max(0, 0.6 * c.value) };
    const fx1 = Math.max(0, c.dx - step), fy1 = Math.max(0, c.dy - step);
    const fx2 = Math.min(rw - size, c.dx + step), fy2 = Math.min(rh - size, c.dy + step);
    const sub = grayRegion(img, x1 + fx1, y1 + fy1, fx2 - fx1 + size, fy2 - fy1 + size);
    const f = nccMap(sub, fx2 - fx1 + size, fy2 - fy1 + size, alpha, size);
    best = argmax(f.map, f.ow);
    best.dx += fx1; best.dy += fy1;
  }
  const x = x1 + best.dx, y = y1 + best.dy;
  let gradient = 0;
  if (best.value > 0.15) {
    const patch = grayRegion(img, x, y, size, size);
    const g = nccMap(sobel(patch, size, size), size, size, sobel(alpha, size, size), size);
    gradient = g.map[0] || 0;
  }
  const confidence = Math.max(0, Math.min(1, 0.6 * best.value + 0.4 * gradient));
  return { variant, size, x, y, ex, ey, spatial: best.value, gradient, confidence };
}

/**
 * Find the most likely watermark placement.
 * Tries the known Gemini placements first, then (optionally) a scale scan for
 * images that were resized after export.
 */
export function detect(img, { deepScan = true } = {}) {
  const { width: W, height: H } = img;
  let best = null;
  for (const p of profilesFor(W, H)) {
    const c = scoreCandidate(img, p.variant, p.size, W - p.margin - p.size, H - p.margin - p.size, p.pad, false, p.snap);
    if (c && (!best || c.confidence > best.confidence)) best = c;
  }
  if (best && best.confidence >= 0.5) return { ...best, method: 'profile' };
  if (deepScan) {
    // Resized export: margin keeps its ratio to logo size (V1 ≈ 2/3, V2 = 2).
    for (let size = 24; size <= 160; size += size < 64 ? 2 : 4) {
      for (const [variant, ratio] of [['V1', 2 / 3], ['V2', 2]]) {
        const margin = Math.round(size * ratio);
        const ex = W - margin - size, ey = H - margin - size;
        if (ex < 0 || ey < 0) continue;
        const pad = Math.max(3, Math.round(size * 0.12));
        const c = scoreCandidate(img, variant, size, ex, ey, pad, true);
        if (c && c.confidence > (best ? best.confidence : 0) + 0.02) best = { ...c, method: 'scan' };
      }
    }
    if (best && best.method === 'scan') {
      // Refine the logo size at full resolution.
      const base = best;
      for (let d = -3; d <= 3; d++) {
        const s = base.size + d;
        if (d === 0 || s < 16) continue;
        const cx = base.x + base.size / 2, cy = base.y + base.size / 2;
        const c = scoreCandidate(img, base.variant, s, Math.round(cx - s / 2), Math.round(cy - s / 2), 3);
        if (c && c.confidence > best.confidence) best = { ...c, method: 'scan' };
      }
    }
  }
  return best ? { method: 'profile', ...best } : null;
}

// ---------- removal ----------
function unblendRegion(img, alpha, n, x, y, gain, logo = 255) {
  const { data, width: W, height: H } = img;
  for (let r = 0; r < n; r++) {
    const py = y + r;
    if (py < 0 || py >= H) continue;
    for (let c = 0; c < n; c++) {
      const px = x + c;
      if (px < 0 || px >= W) continue;
      let a = alpha[r * n + c] * gain;
      if (a < MIN_ALPHA) continue;
      if (a > MAX_ALPHA) a = MAX_ALPHA;
      const inv = 1 / (1 - a), p = (py * W + px) * 4;
      for (let k = 0; k < 3; k++) {
        const v = (data[p + k] - a * logo) * inv;
        data[p + k] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      }
    }
  }
}

function cropRGBA(img, x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) {
    const from = ((y + r) * img.width + x) * 4;
    out.set(img.data.subarray(from, from + w * 4), r * w * 4);
  }
  return { data: out, width: w, height: h };
}

function pasteRGBA(img, patch, x, y) {
  for (let r = 0; r < patch.height; r++) {
    img.data.set(patch.data.subarray(r * patch.width * 4, (r + 1) * patch.width * 4), ((y + r) * img.width + x) * 4);
  }
}

/** Least-squares slope of y on x — how much of template x is still present in y, in absolute units. */
function slope(y, x) {
  const N = x.length;
  let mx = 0, my = 0;
  for (let i = 0; i < N; i++) { mx += x[i]; my += y[i]; }
  mx /= N; my /= N;
  let cov = 0, vx = 0;
  for (let i = 0; i < N; i++) { const dx = x[i] - mx; cov += dx * (y[i] - my); vx += dx * dx; }
  if (vx === 0) return { b: 0, z: 0 };
  const b = cov / vx;
  let rss = 0;
  for (let i = 0; i < N; i++) { const e = y[i] - my - b * (x[i] - mx); rss += e * e; }
  const se = Math.sqrt(rss / Math.max(1, N - 2) / vx) + 1e-6;
  return { b, z: b / se };
}

const sobelCache = new Map();
function alphaEdges(alpha, n) {
  let e = sobelCache.get(alpha);
  if (!e) { e = sobel(alpha, n, n); sobelCache.set(alpha, e); }
  return e;
}

/**
 * Watermark left in a patch, amplitude-aware (unlike NCC, which would blow a
 * 1-level rounding ripple on a flat sky up to a "strong" match).
 * spatial: slope of luminance on alpha. edge: slope of edge strength on the logo outline.
 */
function residual(patch, alpha, n) {
  const g = grayRegion(patch, 0, 0, n, n);
  const s = slope(g, alpha), e = slope(sobel(g, n, n), alphaEdges(alpha, n));
  return { spatial: s.b, edge: e.b, zs: s.z, ze: e.z };
}

// Significance of leftover watermark structure (≈ z-score; smaller is cleaner).
const zscore = (r) => Math.abs(r.zs) + Math.max(0, r.ze);

function unblendCopy(before, alpha, n, g) {
  const trial = { data: new Uint8ClampedArray(before.data), width: n, height: n };
  unblendRegion(trial, alpha, n, 0, 0, g);
  return trial;
}

/** Soften the thin outline where lossy compression noise gets amplified. */
function polishEdges(img, alpha, n, x, y) {
  const { data, width: W, height: H } = img;
  const edge = sobel(alpha, n, n);
  let emax = 0;
  for (let i = 0; i < edge.length; i++) if (edge[i] > emax) emax = edge[i];
  if (emax === 0) return;
  const src = cropRGBA(img, Math.max(0, x - 1), Math.max(0, y - 1), Math.min(W, x + n + 1) - Math.max(0, x - 1), Math.min(H, y + n + 1) - Math.max(0, y - 1));
  const ox = Math.max(0, x - 1), oy = Math.max(0, y - 1);
  const K = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const wgt = Math.min(0.7, (edge[r * n + c] / emax) * 0.9);
      if (wgt < 0.05) continue;
      const px = x + c, py = y + r;
      if (px <= 0 || py <= 0 || px >= W - 1 || py >= H - 1) continue;
      const p = (py * W + px) * 4;
      for (let k = 0; k < 3; k++) {
        let s = 0, i = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          s += src.data[((py + dy - oy) * src.width + (px + dx - ox)) * 4 + k] * K[i++];
        }
        data[p + k] = Math.round(data[p + k] * (1 - wgt) + (s / 16) * wgt);
      }
    }
  }
}

/**
 * Detect and remove the watermark in place.
 * @param img {data: Uint8ClampedArray RGBA, width, height}
 * @param opts {threshold=0.35, force=false, polish=false, adaptive=false, deepScan=true}
 */
export function cleanImage(img, opts = {}) {
  const { threshold = 0.35, force = false, polish = false, adaptive = false, deepScan = true } = opts;
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const ms = () => Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);

  // Gate. A strong match passes outright. A weak match (busy/noisy backgrounds)
  // passes if un-blending makes the shape vanish instead of punching a dark hole.
  const evaluate = (f) => {
    const a = alphaFor(f.variant, f.size);
    const patch = cropRGBA(img, f.x, f.y, f.size, f.size);
    const r0 = residual(patch, a, f.size);
    const r1 = residual(unblendCopy(patch, a, f.size, 1), a, f.size);
    // The logo's crisp outline is the tell: present before, gone after a correct
    // un-blend. Un-blending where there is no logo *creates* that outline instead.
    const verified = f.spatial >= (f.method === 'scan' ? 0.4 : 0.12) && r0.spatial > 0.012 &&
      ((r0.ze > 6 && r1.ze < Math.max(4, 0.25 * r0.ze) && r1.zs < 0.7 * r0.zs) ||
       // Busy / noisy backgrounds drown the outline; there the shape itself must vanish.
       (r0.spatial > 0.05 && r0.zs > 6 && Math.abs(r1.zs) < Math.max(3, 0.15 * r0.zs) && r1.ze < Math.max(3, 0.3 * Math.max(0, r0.ze))));
    // Known layout: a verified match may be faint; an unverified one must be strong.
    // Scale-scan match: must be both strong and verified.
    const pass = f.method === 'scan'
      ? verified && f.confidence >= Math.max(threshold, 0.55) + 0.1
      : verified ? f.confidence >= threshold - 0.15 : f.confidence >= threshold + 0.25;
    let confidence = f.confidence;
    if (verified && pass) confidence = Math.max(confidence, Math.min(0.95, 0.5 + f.spatial));
    return { found: f, r1, confidence, pass };
  };

  let quick = detect(img, { deepScan: false });
  let ev = quick ? evaluate({ ...quick, method: 'profile' }) : null;
  if ((!ev || !ev.pass) && deepScan) {
    const deep = detect(img, { deepScan: true });
    if (deep && deep.method === 'scan') {
      const ev2 = evaluate(deep);
      if (ev2.pass || !ev || ev2.confidence > ev.confidence) ev = ev2;
    }
  }
  if (!ev) return { status: 'skipped', confidence: 0, ms: ms() };
  if (!force && !ev.pass) {
    return { status: 'skipped', confidence: ev.confidence, guess: ev.found, ms: ms() };
  }
  const { found, confidence } = ev;
  const { size: n, variant } = found;
  const alpha = alphaFor(variant, n);
  const zFor = (cx, cy, g) => zscore(residual(unblendCopy(cropRGBA(img, cx, cy, n, n), alpha, n, g), alpha, n));
  let { x, y } = found;
  let best = zFor(x, y, 1);
  // Snapped off the documented spot? Keep the snap only if it leaves clearly less residue.
  if (found.ex != null && (found.ex !== x || found.ey !== y) && found.ex >= 0 && found.ey >= 0 &&
      found.ex + n <= img.width && found.ey + n <= img.height) {
    const zf = zFor(found.ex, found.ey, 1);
    if (!(best < zf - Math.max(3, 0.25 * zf))) { x = found.ex; y = found.ey; best = zf; }
  }
  const zAt = (g) => zFor(x, y, g);

  // Gain: opacity can drift after re-saving or resizing. Stay on the
  // calibrated value unless another one is clearly cleaner.
  let gain = 1;
  if (adaptive && best > 8) {
    let gz = best;
    for (const g of [0.7, 0.8, 0.85, 0.9, 0.95, 1.05, 1.1, 1.15, 1.2, 1.3]) {
      const z = zAt(g);
      if (z < gz) { gz = z; gain = g; }
    }
    if (gz < 0.5 * best) best = gz; else gain = 1;
  }
  unblendRegion(img, alpha, n, x, y, gain);
  const bestRes = best;
  if (polish) polishEdges(img, alpha, n, x, y);

  return {
    status: 'processed',
    variant, size: n, gain,
    region: { x, y, width: n, height: n },
    confidence,
    method: found.method,
    residual: bestRes,
    ms: ms(),
  };
}

/** Stamp a watermark (for self-tests / demos only). */
export function stamp(img, variant, size, x, y, gain = 1) {
  const alpha = alphaFor(variant, size);
  const { data, width: W } = img;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    const a = Math.min(MAX_ALPHA, alpha[r * size + c] * gain);
    if (a < MIN_ALPHA) continue;
    const p = ((y + r) * W + x + c) * 4;
    for (let k = 0; k < 3; k++) data[p + k] = Math.round(a * 255 + (1 - a) * data[p + k]);
  }
}

/** Debug helper: detection + residual statistics at the best known-layout candidate. */
export function diagnose(img) {
  const f = detect(img, { deepScan: false });
  if (!f) return null;
  const a = alphaFor(f.variant, f.size);
  const patch = cropRGBA(img, f.x, f.y, f.size, f.size);
  return { ...f, r0: residual(patch, a, f.size), r1: residual(unblendCopy(patch, a, f.size, 1), a, f.size) };
}
