/*
 * EXPERIMENT (not shipping code): does HPS/SHS-style harmonic reinforcement
 * on the raw ink-projection autocorrelation fix the x2 pitch failures on the
 * external holdout, without breaking the 5/5 bro gate?
 *
 * Per docs/RESEARCH.md sec.1: the repo's existing dot-lattice comb
 * (grid.js combScore/midpointStrength) is already HPS-in-spirit but only
 * fires when a printed dot lattice exists. This script tests the
 * generalized form directly on DS.projections() (the raw row/col ink
 * projection grid.js exports and explicitly says autocorrelation on this
 * signal alone "collapses" under hatching) -- i.e. it tests whether
 * harmonic reinforcement rescues the exact method grid.js's own header
 * comment says was abandoned.
 *
 * Decode/shim/pipeline block is copied verbatim in spirit from
 * tools/realgate.js (sips->BMP->parseBMP, canvas shim, DS module load) --
 * NOT reinvented. grid.js is not modified; only DS.projections and
 * DS.estimateGrid (both already exported) are called.
 *
 *   node tools/exp-hps.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BRO_DIR = path.join(ROOT, 'datasets', 'real-maps');
const EXT_DIR = path.join(ROOT, 'datasets', 'external');
const MAXDIM = 1600;

// ---- frozen truths (do NOT invent; copied from realgate.js EXPECT + SOURCES.md) ----
const BRO_TRUTH = { 'bro-01': 28, 'bro-02': 48, 'bro-03': 41, 'bro-04': 45, 'bro-05': 40 };
const BRO_TOL = 2;
// { truth, approx } -- approx=true means SOURCES.md marked it "~" (tolerance widened)
const EXT_TRUTH = {
  'dyson-pit-dungeon-levels-5-8': { truth: 33, approx: false },
  'frikistein-Guia-Dibujar-Mapa-Rol-23-Listo': { truth: 13, approx: false },
  'dyson-flooded-catacombs': { truth: 36, approx: true },
  'dyson-scavengers-deep-33': { truth: 17, approx: true },
  'wistedt-tut-2': { truth: 88, approx: true }, // dot pitch; corridor = 1 dot-cell
  // wistedt-tut-11: unscoreable (no canonical grid) -- deliberately excluded
};
function tol(t) { return t.approx ? Math.max(3, Math.round(0.15 * t.truth)) : 2; }

// --------------------------- BMP bridge (sips) -- copied from realgate.js ---------------------------
function imgToImageData(srcPath, maxDim) {
  const tmp = path.join('/tmp', '_exphps_' + path.basename(srcPath).replace(/\.[^.]+$/, '') + '.bmp');
  execFileSync('sips', ['-s', 'format', 'bmp', srcPath, '--out', tmp,
    ...(maxDim ? ['-Z', String(maxDim)] : [])], { stdio: 'ignore' });
  const buf = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  return parseBMP(buf);
}
function parseBMP(buf) {
  if (buf.readUInt16LE(0) !== 0x4d42) throw new Error('not a BMP');
  const dataOff = buf.readUInt32LE(10);
  const w = buf.readInt32LE(18);
  let h = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const comp = buf.readUInt32LE(30);
  if (comp !== 0 && comp !== 3) throw new Error('compressed BMP (' + comp + ') unsupported');
  const flip = h > 0; h = Math.abs(h);
  const bytes = bpp / 8;
  const stride = Math.floor((w * bpp + 31) / 32) * 4;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcY = flip ? h - 1 - y : y;
    let s = dataOff + srcY * stride;
    let d = y * w * 4;
    for (let x = 0; x < w; x++, s += bytes, d += 4) {
      out[d] = buf[s + 2]; out[d + 1] = buf[s + 1]; out[d + 2] = buf[s];
      out[d + 3] = bytes === 4 ? buf[s + 3] : 255;
    }
  }
  return { width: w, height: h, data: out };
}

// --------------------------- canvas shim -- copied from realgate.js ---------------------------
function makeCanvas(w, h) {
  const cv = { _img: { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } };
  Object.defineProperty(cv, 'width', {
    get() { return cv._img.width; },
    set(v) { cv._img = { width: v, height: cv._img.height, data: new Uint8ClampedArray(Math.max(0, v * cv._img.height * 4)) }; },
  });
  Object.defineProperty(cv, 'height', {
    get() { return cv._img.height; },
    set(v) { cv._img = { width: cv._img.width, height: v, data: new Uint8ClampedArray(Math.max(0, cv._img.width * v * 4)) }; },
  });
  const ident = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  let M = ident();
  const ctx = {
    canvas: cv,
    fillStyle: '#fff', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    save() { this._saved = { ...M }; }, restore() { if (this._saved) M = this._saved; },
    translate(tx, ty) { M = { ...M, e: M.a * tx + M.c * ty + M.e, f: M.b * tx + M.d * ty + M.f }; },
    rotate(t) {
      const c = Math.cos(t), s = Math.sin(t);
      M = { a: M.a * c + M.c * s, b: M.b * c + M.d * s, c: -M.a * s + M.c * c, d: -M.b * s + M.d * c, e: M.e, f: M.f };
    },
    fillRect(x0, y0, fw, fh) {
      const [r, g, b] = cssRGB(this.fillStyle);
      const d = cv._img.data, W = cv.width, H = cv.height;
      if (x0 === undefined) { x0 = 0; y0 = 0; fw = W; fh = H; }
      for (let y = Math.max(0, y0 | 0); y < Math.min(H, y0 + fh); y++)
        for (let x = Math.max(0, x0 | 0); x < Math.min(W, x0 + fw); x++) {
          const i = (y * W + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
        }
    },
    drawImage(src, dx, dy, dw, dh) {
      const simg = src._img, sw = simg.width, sh = simg.height;
      if (dw === undefined) { dw = sw; dh = sh; }
      const W = cv.width, H = cv.height, d = cv._img.data, sd = simg.data;
      const det = M.a * M.d - M.b * M.c;
      const isIdent = M.a === 1 && M.b === 0 && M.c === 0 && M.d === 1 && M.e === 0 && M.f === 0;
      if (isIdent) {
        for (let y = 0; y < dh; y++) {
          const oy = (dy | 0) + y; if (oy < 0 || oy >= H) continue;
          const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sh / dh - 0.5));
          for (let x = 0; x < dw; x++) {
            const ox = (dx | 0) + x; if (ox < 0 || ox >= W) continue;
            const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sw / dw - 0.5));
            blendBilinear(sd, sw, sh, sx, sy, d, (oy * W + ox) * 4);
          }
        }
        return;
      }
      const ia = M.d / det, ib = -M.b / det, ic = -M.c / det, id = M.a / det;
      const ie = -(ia * M.e + ic * M.f), iff = -(ib * M.e + id * M.f);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const ux = ia * x + ic * y + ie - dx, uy = ib * x + id * y + iff - dy;
          const sx = ux * sw / dw, sy = uy * sh / dh;
          if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) continue;
          blendBilinear(sd, sw, sh, sx, sy, d, (y * W + x) * 4);
        }
      }
    },
    getImageData(x, y, gw, gh) {
      const W = cv.width;
      if (x === 0 && y === 0 && gw === W && gh === cv.height)
        return { width: gw, height: gh, data: new Uint8ClampedArray(cv._img.data) };
      const out = new Uint8ClampedArray(gw * gh * 4);
      for (let yy = 0; yy < gh; yy++)
        for (let xx = 0; xx < gw; xx++) {
          const si = ((y + yy) * W + (x + xx)) * 4, di = (yy * gw + xx) * 4;
          out[di] = cv._img.data[si]; out[di + 1] = cv._img.data[si + 1];
          out[di + 2] = cv._img.data[si + 2]; out[di + 3] = cv._img.data[si + 3];
        }
      return { width: gw, height: gh, data: out };
    },
    createImageData(w2, h2) { return { width: w2, height: h2, data: new Uint8ClampedArray(w2 * h2 * 4) }; },
    putImageData(img, x, y) {
      if ((x | 0) === 0 && (y | 0) === 0 && img.width === cv.width && img.height === cv.height) { cv._img = img; return; }
      const W = cv.width, d = cv._img.data;
      for (let yy = 0; yy < img.height; yy++)
        for (let xx = 0; xx < img.width; xx++) {
          const di = ((y + yy) * W + (x + xx)) * 4, si = (yy * img.width + xx) * 4;
          d[di] = img.data[si]; d[di + 1] = img.data[si + 1]; d[di + 2] = img.data[si + 2]; d[di + 3] = img.data[si + 3];
        }
    },
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {},
  };
  cv.getContext = () => ctx;
  return cv;
}
function blendBilinear(sd, sw, sh, sx, sy, d, o) {
  const x0 = sx | 0, y0 = sy | 0, x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
  const fx = sx - x0, fy = sy - y0;
  const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
  for (let c = 0; c < 3; c++) {
    const top = sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx;
    const bot = sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx;
    d[o + c] = top * (1 - fy) + bot * fy;
  }
  d[o + 3] = 255;
}
function cssRGB(s) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s || '');
  if (!m) return [255, 255, 255];
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// --------------------------- load renderer modules (unmodified) ---------------------------
global.window = {};
global.document = { createElement: () => makeCanvas(1, 1) };
for (const mod of ['digitize.js', 'perspective.js', 'rectify.js', 'grid.js']) {
  eval(fs.readFileSync(path.join(ROOT, 'renderer', mod), 'utf8'));
}
const DS = window.DS;

// --------------------------- HPS/SHS experiment machinery ---------------------------
// Normalized (zero-mean) autocorrelation coefficient at integer lag `lag`.
function acfSpectrum(P) {
  const n = P.length;
  let mean = 0; for (let i = 0; i < n; i++) mean += P[i]; mean /= n;
  const c = new Float64Array(n);
  for (let i = 0; i < n; i++) c[i] = P[i] - mean;
  let var0 = 0; for (let i = 0; i < n; i++) var0 += c[i] * c[i];
  return function acf(lag) {
    lag = Math.round(lag);
    if (lag <= 0 || lag >= n || var0 <= 0) return 0;
    let s = 0; for (let i = 0; i + lag < n; i++) s += c[i] * c[i + lag];
    return s / var0; // ~[-1,1]
  };
}

// score(p): combined col+row autocorrelation on DS.projections() -- the raw
// ink projection grid.js exports (NOT the internal run-length-filtered P;
// this is deliberately the signal grid.js's own header comment says
// "collapses" under hatching -- that collapse is exactly what we're testing
// whether harmonic reinforcement can rescue).
function buildScoreFn(gray, W, H) {
  const { col, row } = DS.projections(gray, W, H);
  const acfCol = acfSpectrum(col), acfRow = acfSpectrum(row);
  return (p) => (acfCol(p) + acfRow(p)) / 2;
}

function argmaxOver(fn, lo, hi) {
  let best = lo, bestV = -Infinity;
  for (let p = lo; p <= hi; p++) { const v = fn(p); if (v > bestV) { bestV = v; best = p; } }
  return { p: best, v: bestV };
}

// Harmonic reinforcement variants. score(p) is the raw ACF-combined value;
// clamp to >=0 before multiplying (ACF can be negative; HPS multiplies
// nonnegative magnitude-like quantities).
function variants(score) {
  const pos = (p) => Math.max(0, score(p));
  return {
    'RAW (argmax ACF, no reinforcement)': (p) => score(p),
    'HPS-multiply (p,2p,3p)': (p) => pos(p) * pos(2 * p) * pos(3 * p),
    'HPS-multiply+sub (p,2p,p/2)': (p) => pos(p) * pos(2 * p) * pos(p / 2),
    'SHS-sum (p + .5*2p + .33*3p)': (p) => score(p) + 0.5 * score(2 * p) + 0.33 * score(3 * p),
    'SHS-sum+sub (p + .5*2p + .5*p/2)': (p) => score(p) + 0.5 * score(2 * p) + 0.5 * score(p / 2),
  };
}

// --------------------------- pipeline per map (rectify->deskew->gray) ---------------------------
function loadGray(srcPath) {
  const raw = imgToImageData(srcPath, MAXDIM);
  const work0 = makeCanvas(raw.width, raw.height);
  work0._img = { width: raw.width, height: raw.height, data: raw.data };
  const rect = DS.perspective.autoRectify(work0);
  let work = rect.canvas;
  const de = DS.smartDeskew(work); work = de.canvas;
  const W = work.width, H = work.height;
  const gray = DS.toGray(work.getContext('2d').getImageData(0, 0, W, H));
  return { gray, W, H };
}

function runMap(name, srcPath, truthEntry) {
  const { gray, W, H } = loadGray(srcPath);
  const est = DS.estimateGrid(gray, W, H);
  const currentS = est.s;
  const lo = Math.max(8, Math.round(Math.min(W, H) / 60));
  const hi = Math.round(Math.min(W, H) / 4);
  const score = buildScoreFn(gray, W, H);
  const vs = variants(score);
  const picks = {};
  for (const [vname, fn] of Object.entries(vs)) picks[vname] = argmaxOver(fn, lo, hi).p;
  // DIAGNOSTIC: is the truth pitch even locally present in the raw ACF, or is
  // it drowned out entirely? (why-it-fails evidence, not part of the picks)
  if (process.env.DEBUG_HPS) {
    const t = truthEntry ? (typeof truthEntry === 'object' ? truthEntry.truth : truthEntry) : null;
    const { p: gp, v: gv } = argmaxOver(score, lo, hi);
    const tv = t ? score(t) : null;
    console.log(`  [diag] ${name}: global argmax p=${gp} score=${gv.toFixed(4)}` +
      (t ? `  |  score(truth=${t})=${tv.toFixed(4)}  ratio=${(tv / gv).toFixed(2)}` : ''));
  }
  return { name, currentS, picks, truth: truthEntry };
}

function verdict(pick, truth) {
  if (truth == null) return { ok: null, tag: 'n/a (no truth)' };
  const t = typeof truth === 'object' ? truth.truth : truth;
  const tl = typeof truth === 'object' ? tol(truth) : BRO_TOL;
  const ok = Math.abs(pick - t) <= tl;
  return { ok, tag: ok ? 'OK' : 'WRONG' };
}

// --------------------------- main ---------------------------
const rows = [];
for (const [name, truth] of Object.entries(BRO_TRUTH)) {
  rows.push({ group: 'bro', ...runMap(name, path.join(BRO_DIR, name + '.jpg'), truth) });
}
const extFiles = fs.readdirSync(EXT_DIR).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
for (const f of extFiles) {
  const name = f.replace(/\.[^.]+$/, '');
  if (name === 'wistedt-tut-11') continue; // pre-registered unscoreable, skip
  const truth = EXT_TRUTH[name] || null;
  try {
    rows.push({ group: 'ext', ...runMap(name, path.join(EXT_DIR, f), truth) });
  } catch (e) {
    rows.push({ group: 'ext', name, error: e.message });
  }
}

// --------------------------- report ---------------------------
const variantNames = Object.keys(variants(() => 0));
console.log('map | truth | current s (verdict) | ' + variantNames.map((v) => v + ' (verdict)').join(' | '));
console.log('-'.repeat(40));
let brokeBro = false;
for (const r of rows) {
  if (r.error) { console.log(`${r.name}: ERROR ${r.error}`); continue; }
  const t = r.truth ? (typeof r.truth === 'object' ? r.truth.truth : r.truth) : null;
  const approxFlag = r.truth && typeof r.truth === 'object' && r.truth.approx ? '~' : '';
  const curV = verdict(r.currentS, r.truth);
  const parts = [`${r.name} [${r.group}]`, t == null ? '—' : `${approxFlag}${t}`, `${r.currentS} (${curV.tag})`];
  for (const vn of variantNames) {
    const pick = r.picks[vn];
    const v = verdict(pick, r.truth);
    let fb = 'n/a';
    if (v.ok != null) {
      if (r.group === 'bro') fb = v.ok ? 'SAME' : 'BROKE';
      else fb = (!curV.ok && v.ok) ? 'FIXED' : (curV.ok && !v.ok) ? 'BROKE' : 'SAME';
    }
    if (r.group === 'bro' && fb === 'BROKE') brokeBro = true;
    parts.push(`${pick} (${fb})`);
  }
  console.log(parts.join(' | '));
}
console.log('\nHARD CONSTRAINT (bro must stay 28/48/41/45/40 +-2): ' + (brokeBro ? 'VIOLATED by at least one variant' : 'held by all variants'));
