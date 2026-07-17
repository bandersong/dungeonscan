/*
 * Experiment: is structure-tensor orientation coherence separable for
 * pale-grid-line vs dark-wall-stroke vs hatch-texture vs blank-paper pixels?
 *
 * This is docs/RESEARCH.md Ranked Experiment #1 (the cheapest falsifier for
 * the §3 pale-stroke frontier) — a numbers-only offline analysis, no
 * detectWalls changes. Decode/rectify harness copied verbatim from
 * tools/realgate.js per its own header instructions.
 *
 *   node tools/exp-coherence.js
 *
 * Prints per-class/per-scale coherence distributions + a SEPARABLE/NOT
 * verdict with a threshold recipe (or a clean falsification) to stdout.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MAPS_DIR = path.join(ROOT, 'datasets', 'real-maps');
const OUT = process.env.OUT || '/tmp/exp-coherence';
const MAXDIM = 1600;
const WIN = 16; // px, fixed window half-size*2 — small enough to stay inside one grid cell on both maps (s=28 & s=41), big enough to span a stroke + band.

// --------------------------- BMP bridge (sips) — copied from realgate.js ---------------------------
function jpegToImageData(jpgPath, maxDim) {
  const tmp = path.join(OUT, '_in_' + path.basename(jpgPath, '.jpg') + '.bmp');
  execFileSync('sips', ['-s', 'format', 'bmp', jpgPath, '--out', tmp,
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

// --------------------------- canvas shim — copied from realgate.js ---------------------------
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

// --------------------------- load renderer modules (read-only use) ---------------------------
global.window = {};
global.document = { createElement: () => makeCanvas(1, 1) };
for (const mod of ['digitize.js', 'perspective.js', 'rectify.js', 'grid.js']) {
  eval(fs.readFileSync(path.join(ROOT, 'renderer', mod), 'utf8'));
}
const DS = window.DS;

// --------------------------- structure tensor ---------------------------
function sobel(gray, W, H) {
  const Gx = new Float32Array(W * H), Gy = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const a = gray[i - W - 1], b = gray[i - W], c = gray[i - W + 1];
      const d = gray[i - 1], f = gray[i + 1];
      const g = gray[i + W - 1], h = gray[i + W], k = gray[i + W + 1];
      Gx[i] = (c + 2 * f + k) - (a + 2 * d + g);
      Gy[i] = (g + 2 * h + k) - (a + 2 * b + c);
    }
  }
  return { Gx, Gy };
}
// separable Gaussian blur, clamp-to-edge border
function gaussianBlur(src, W, H, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let ksum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; ksum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= ksum;
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const base = y * W;
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) { const xx = Math.min(W - 1, Math.max(0, x + i)); s += src[base + xx] * k[i + r]; }
      tmp[base + x] = s;
    }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let s = 0;
      for (let i = -r; i <= r; i++) { const yy = Math.min(H - 1, Math.max(0, y + i)); s += tmp[yy * W + x] * k[i + r]; }
      out[y * W + x] = s;
    }
  }
  return out;
}
// per image, per scale: smoothed structure-tensor components + per-pixel coherence
function tensorAtScale(gray, W, H, Gx, Gy, sigma) {
  const n = W * H;
  const jxx0 = new Float32Array(n), jyy0 = new Float32Array(n), jxy0 = new Float32Array(n);
  for (let i = 0; i < n; i++) { jxx0[i] = Gx[i] * Gx[i]; jyy0[i] = Gy[i] * Gy[i]; jxy0[i] = Gx[i] * Gy[i]; }
  const Jxx = gaussianBlur(jxx0, W, H, sigma), Jyy = gaussianBlur(jyy0, W, H, sigma), Jxy = gaussianBlur(jxy0, W, H, sigma);
  const coh = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const tr = Jxx[i] + Jyy[i];
    const disc = Math.sqrt((Jxx[i] - Jyy[i]) * (Jxx[i] - Jyy[i]) + 4 * Jxy[i] * Jxy[i]);
    coh[i] = tr > 1e-6 ? disc / tr : 0; // (l1-l2)/(l1+l2)
  }
  return { Jxx, Jyy, Jxy, coh };
}
// window stats: median per-pixel coherence, and aggregate-tensor coherence (sum
// Jxx/Jyy/Jxy over the window THEN eigen-decompose) — the gap between the two is
// "dominant-orientation consistency": a real stroke stays coherent when pooled,
// crossing hatch/texture cancels out under pooling even if locally edge-like.
function windowStats(T, W, H, cx, cy, half) {
  const cohVals = [];
  let sxx = 0, syy = 0, sxy = 0, n = 0;
  for (let y = cy - half; y < cy + half; y++) {
    if (y < 0 || y >= H) continue;
    const base = y * W;
    for (let x = cx - half; x < cx + half; x++) {
      if (x < 0 || x >= W) continue;
      const i = base + x;
      cohVals.push(T.coh[i]);
      sxx += T.Jxx[i]; syy += T.Jyy[i]; sxy += T.Jxy[i]; n++;
    }
  }
  if (!n) return null;
  cohVals.sort((a, b) => a - b);
  const pixelCoh = cohVals[cohVals.length >> 1];
  const tr = sxx + syy, disc = Math.sqrt((sxx - syy) * (sxx - syy) + 4 * sxy * sxy);
  const aggCoh = tr > 1e-6 ? disc / tr : 0;
  const orientConsistency = pixelCoh > 1e-3 ? aggCoh / pixelCoh : 0;
  return { aggCoh, pixelCoh, orientConsistency };
}

// --------------------------- pipeline per map (mirrors realgate.js runMap, no overlays) ---------------------------
function loadMap(name) {
  const jpg = path.join(MAPS_DIR, name + '.jpg');
  const raw = jpegToImageData(jpg, MAXDIM);
  const work0 = makeCanvas(raw.width, raw.height);
  work0._img = { width: raw.width, height: raw.height, data: raw.data };
  const rect = DS.perspective.autoRectify(work0);
  let work = rect.canvas;
  const de = DS.smartDeskew(work); work = de.canvas;
  const W = work.width, H = work.height;
  const gray = DS.toGray(work.getContext('2d').getImageData(0, 0, W, H));
  const est = DS.estimateGrid(gray, W, H);
  const grid = { s: est.s, ox: est.ox, oy: est.oy, C: est.C, R: est.R };
  const walls = DS.detectWalls(gray, W, H, grid);
  const { cm, sd } = DS.cellInk(gray, W, H, grid);
  return { name, gray, W, H, grid, walls, cm, sd };
}

// --------------------------- candidate windows + class selection ---------------------------
function median(a) { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; }
function percentile(a, f) { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(f * (s.length - 1))))]; }
function stats(a) { if (!a.length) return { median: NaN, p10: NaN, p90: NaN, n: 0 }; return { median: median(a), p10: percentile(a, 0.10), p90: percentile(a, 0.90), n: a.length }; }
function pick(arr, n) { if (arr.length <= n) return arr; const step = arr.length / n; return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]); }

function edgeCandidates(m) {
  const { grid, walls, W, H } = m, { s, ox, oy, C, R } = grid;
  const half = WIN / 2, out = [];
  for (let row = 0; row < R; row++) {
    for (let col = 0; col <= C; col++) {
      const cx = Math.round(ox + col * s), cy = Math.round(oy + (row + 0.5) * s);
      if (cx - half < 0 || cx + half >= W || cy - half < 0 || cy + half >= H) continue;
      out.push({ score: walls.vScore[row][col], flagged: !!walls.vEdge[row][col], cx, cy });
    }
  }
  for (let row = 0; row <= R; row++) {
    for (let col = 0; col < C; col++) {
      const cx = Math.round(ox + (col + 0.5) * s), cy = Math.round(oy + row * s);
      if (cx - half < 0 || cx + half >= W || cy - half < 0 || cy + half >= H) continue;
      out.push({ score: walls.hScore[row][col], flagged: !!walls.hEdge[row][col], cx, cy });
    }
  }
  return out;
}
function cellCandidates(m) {
  const { grid, cm, sd, W, H } = m, { s, ox, oy, C, R } = grid;
  const half = WIN / 2, out = [];
  for (let row = 0; row < R; row++) {
    for (let col = 0; col < C; col++) {
      const cx = Math.round(ox + (col + 0.5) * s), cy = Math.round(oy + (row + 0.5) * s);
      if (cx - half < 0 || cx + half >= W || cy - half < 0 || cy + half >= H) continue;
      out.push({ cm: cm[row * C + col], sd: sd[row * C + col], cx, cy });
    }
  }
  return out;
}

// --------------------------- main ---------------------------
fs.mkdirSync(OUT, { recursive: true });
const N_SAMPLE = 40;
const SIGMAS = [1, 2, 4];

const bro01 = loadMap('bro-01');
const bro03 = loadMap('bro-03');

// --- class definitions (numeric, from each map's own ink-score / cell-ink distributions) ---
const e01 = edgeCandidates(bro01), e03 = edgeCandidates(bro03);
const thr01 = bro01.walls.threshold, thr03 = bro03.walls.threshold;

const flagged01 = e01.filter((e) => e.flagged).map((e) => e.score);
// unflagged splits into two very different populations: genuinely below the
// wall-ink threshold (candidates for "pale stroke"), vs AT/ABOVE threshold but
// vetoed by the continuity gate (broken/dotty ink, not what "pale" means here).
// Restrict to the below-threshold band before taking the top percentile of it.
const belowThr01 = e01.filter((e) => !e.flagged && e.score < thr01).map((e) => e.score);
const darkLo01 = median(flagged01);         // top half of FLAGGED (detected) wall edges = confidently dark
const paleLo01 = percentile(belowThr01, 0.70); // top 30% of the below-threshold band = closest-to-threshold, most-likely-genuine faint ink

const flagged03 = e03.filter((e) => e.flagged).map((e) => e.score);
const darkLo03 = median(flagged03);

const darkWall01 = pick(e01.filter((e) => e.flagged && e.score >= darkLo01), N_SAMPLE);
const paleWall01 = pick(e01.filter((e) => !e.flagged && e.score >= paleLo01 && e.score < thr01), N_SAMPLE);
const darkWall03 = pick(e03.filter((e) => e.flagged && e.score >= darkLo03), N_SAMPLE);

const c03 = cellCandidates(bro03);
const sdAll03 = c03.map((c) => c.sd);
const hatchSdLo = percentile(sdAll03, 0.66); // top tercile of interior cell sd on bro-03 = clearly-textured (hatched), per digitize.js's own sd 2.6-vs-57.8 flat/drawn split
const hatch03 = pick(c03.filter((c) => c.sd >= hatchSdLo), N_SAMPLE);

const c01 = cellCandidates(bro01);
const cmAll = c01.map((c) => c.cm).concat(c03.map((c) => c.cm));
const sdAllBoth = c01.map((c) => c.sd).concat(c03.map((c) => c.sd));
const cmLo = percentile(cmAll, 0.30), sdLo = percentile(sdAllBoth, 0.30);
const blankPool = c01.map((c) => ({ ...c, _map: 'bro-01' })).concat(c03.map((c) => ({ ...c, _map: 'bro-03' })));
const blankPaper = pick(blankPool.filter((c) => c.cm <= cmLo && c.sd <= sdLo), N_SAMPLE);

console.log('--- class thresholds (numeric, inspected from data) ---');
console.log(`bro-01 detectWalls threshold=${thr01}  flagged-edge scores median=${darkLo01.toFixed(1)} (n=${flagged01.length})  below-threshold-unflagged p70=${paleLo01.toFixed(1)} (n=${belowThr01.length})`);
console.log(`bro-03 detectWalls threshold=${thr03}  flagged-edge scores median=${darkLo03.toFixed(1)} (n=${flagged03.length})`);
console.log(`bro-03 interior-cell sd p66 (hatch cutoff)=${hatchSdLo.toFixed(1)}  (n cells=${sdAll03.length})`);
console.log(`pooled blank-cell cutoff: cm<=${cmLo.toFixed(1)} sd<=${sdLo.toFixed(1)}`);
console.log(`sample counts used: dark01=${darkWall01.length} pale01=${paleWall01.length} dark03=${darkWall03.length} hatch03=${hatch03.length} blank=${blankPaper.length}\n`);

// --------------------------- compute coherence per class per scale ---------------------------
const classes = [
  { name: 'bro01_dark_wall', map: bro01, wins: darkWall01 },
  { name: 'bro01_pale_wall', map: bro01, wins: paleWall01 },
  { name: 'bro03_dark_wall', map: bro03, wins: darkWall03 },
  { name: 'bro03_hatch', map: bro03, wins: hatch03 },
  { name: 'blank_paper', map: null, wins: blankPaper },
];

// precompute Sobel + tensors per scale per map
const tensors = {};
for (const [key, m] of [['bro-01', bro01], ['bro-03', bro03]]) {
  const { Gx, Gy } = sobel(m.gray, m.W, m.H);
  tensors[key] = SIGMAS.map((sig) => tensorAtScale(m.gray, m.W, m.H, Gx, Gy, sig));
}

const results = {}; // results[className][scaleIx] = { aggCoh:[...], orient:[...] }
for (const cls of classes) {
  results[cls.name] = SIGMAS.map(() => ({ aggCoh: [], orient: [] }));
  for (const w of cls.wins) {
    const key = cls.map ? cls.map.name : w._map; // blank_paper carries its source map per-sample
    const srcMap = key === 'bro-01' ? bro01 : bro03;
    const T3 = tensors[key];
    for (let si = 0; si < SIGMAS.length; si++) {
      const st = windowStats(T3[si], srcMap.W, srcMap.H, w.cx, w.cy, WIN / 2);
      if (st) { results[cls.name][si].aggCoh.push(st.aggCoh); results[cls.name][si].orient.push(st.orientConsistency); }
    }
  }
}

console.log('--- per-class / per-scale structure-tensor coherence (aggregate-window) ---');
console.log('class            sigma  n   coh_p10  coh_med  coh_p90 | orient_p10 orient_med orient_p90');
for (const cls of classes) {
  for (let si = 0; si < SIGMAS.length; si++) {
    const a = stats(results[cls.name][si].aggCoh), o = stats(results[cls.name][si].orient);
    console.log(`${cls.name.padEnd(16)} s=${SIGMAS[si]}  ${String(a.n).padStart(3)}  ${a.p10.toFixed(3).padStart(7)}  ${a.median.toFixed(3).padStart(7)}  ${a.p90.toFixed(3).padStart(7)} |   ${o.p10.toFixed(3).padStart(6)}    ${o.median.toFixed(3).padStart(6)}     ${o.p90.toFixed(3)}`);
  }
}

// --------------------------- verdict: pale-wall vs hatch (the load-bearing test) ---------------------------
function bestThreshold(pos, neg) {
  if (!pos.length || !neg.length) return null;
  const all = pos.concat(neg).slice().sort((a, b) => a - b);
  let best = null;
  for (const t of all) {
    const tp = pos.filter((v) => v >= t).length, fn = pos.length - tp;
    const fp = neg.filter((v) => v >= t).length;
    const prec = tp / (tp + fp || 1), rec = tp / (tp + fn || 1);
    const f1 = 2 * prec * rec / (prec + rec || 1);
    if (!best || f1 > best.f1) best = { t, f1, prec, rec };
  }
  return best;
}

console.log('\n--- verdict: bro01_pale_wall (stroke, hard case) vs bro03_hatch (texture) ---');
let bestOverall = null;
for (let si = 0; si < SIGMAS.length; si++) {
  const pale = results.bro01_pale_wall[si].aggCoh, hatch = results.bro03_hatch[si].aggCoh;
  const ps = stats(pale), hs = stats(hatch);
  const margin = ps.p10 - hs.p90; // >0 = clean gap between pale-wall p10 and hatch p90
  const bt = bestThreshold(pale, hatch);
  console.log(`sigma=${SIGMAS[si]}  pale[p10,med,p90]=[${ps.p10.toFixed(3)},${ps.median.toFixed(3)},${ps.p90.toFixed(3)}]  hatch[p10,med,p90]=[${hs.p10.toFixed(3)},${hs.median.toFixed(3)},${hs.p90.toFixed(3)}]  margin(pale.p10-hatch.p90)=${margin.toFixed(3)}  bestF1=${bt.f1.toFixed(2)} @thr=${bt.t.toFixed(3)} (prec=${bt.prec.toFixed(2)} rec=${bt.rec.toFixed(2)})`);
  if (!bestOverall || bt.f1 > bestOverall.f1) bestOverall = { sigma: SIGMAS[si], margin, ...bt };
}

console.log('\n--- sanity anchor: bro01_dark_wall vs blank_paper (should separate trivially if the method works at all) ---');
for (let si = 0; si < SIGMAS.length; si++) {
  const dark = results.bro01_dark_wall[si].aggCoh, blank = results.blank_paper[si].aggCoh;
  const ds = stats(dark), bs = stats(blank);
  console.log(`sigma=${SIGMAS[si]}  dark[p10,med,p90]=[${ds.p10.toFixed(3)},${ds.median.toFixed(3)},${ds.p90.toFixed(3)}]  blank[p10,med,p90]=[${bs.p10.toFixed(3)},${bs.median.toFixed(3)},${bs.p90.toFixed(3)}]  margin=${(ds.p10 - bs.p90).toFixed(3)}`);
}

console.log('\n=== VERDICT ===');
if (bestOverall.margin > 0.03) {
  console.log(`SEPARABLE: pale-wall vs hatch coherence has a clean gap at sigma=${bestOverall.sigma} (margin ${bestOverall.margin.toFixed(3)}, pale.p10 above hatch.p90). Threshold recipe: aggregate-window structure-tensor coherence at sigma=${bestOverall.sigma}, threshold=${bestOverall.t.toFixed(3)} → precision=${bestOverall.prec.toFixed(2)} recall=${bestOverall.rec.toFixed(2)} (F1=${bestOverall.f1.toFixed(2)}) on the sampled windows.`);
} else if (bestOverall.f1 >= 0.85) {
  console.log(`SEPARABLE (overlapping tails but a workable operating point): best F1=${bestOverall.f1.toFixed(2)} at sigma=${bestOverall.sigma}, threshold=${bestOverall.t.toFixed(3)} (precision=${bestOverall.prec.toFixed(2)} recall=${bestOverall.rec.toFixed(2)}). Distributions overlap (margin ${bestOverall.margin.toFixed(3)} <= 0) so no threshold is loss-free, but this operating point is usable as a second gate alongside continuity.`);
} else {
  console.log(`NOT CLEANLY SEPARABLE: best achievable F1 across scales is only ${bestOverall.f1.toFixed(2)} (sigma=${bestOverall.sigma}, thr=${bestOverall.t.toFixed(3)}, prec=${bestOverall.prec.toFixed(2)} rec=${bestOverall.rec.toFixed(2)}), distributions overlap by margin ${bestOverall.margin.toFixed(3)}. The structure-tensor coherence hypothesis is falsified at this window size/scale set — do not proceed to Ranked Experiment #2 without revisiting window size or escalating straight to Frangi (#3).`);
}

fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ classes: Object.keys(results).map((k) => ({ name: k, scales: results[k].map((r, i) => ({ sigma: SIGMAS[i], aggCoh: stats(r.aggCoh), orient: stats(r.orient) })) })), verdict: bestOverall }, null, 2));
console.log(`\nresults.json → ${OUT}`);
