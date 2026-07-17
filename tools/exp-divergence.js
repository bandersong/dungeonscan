/*
 * Root-cause experiment for the bro-03 pitch divergence (node s=41, Chromium
 * s=42, WKWebView s=44) — SAME renderer JS on all three surfaces, so the only
 * free variable per surface is HOW the working-res canvas gets its pixels:
 *   - node gate:   sips decodes+downscales the JPEG in ONE step (-Z 1600),
 *                  using macOS ImageIO's own resampling filter.
 *   - Chromium:    <img> decodes at full res, then ctx.drawImage(img,0,0,w,h)
 *                  resamples with Skia's canvas filter.
 *   - WKWebView:   same drawImage() call, but resampled by CoreGraphics'
 *                  canvas backend instead of Skia.
 * Same JS, three different native resamplers under drawImage/-Z. Hypothesis:
 * estimateGrid's run-length line detector (grid.js) is sensitive to exactly
 * where anti-aliased line edges cross its threshold, so different resamplers
 * feeding the identical downstream code produce different s.
 *
 * This script holds the pipeline fixed and only swaps the resize filter used
 * to go from the full-res decode to the MAXDIM working canvas, to see how much
 * of the 41→44 spread a resampling-filter change alone can produce.
 *
 *   node tools/exp-divergence.js            bro-03, all methods
 *   node tools/exp-divergence.js bro-02     any other map
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MAPS_DIR = path.join(ROOT, 'datasets', 'real-maps');
const OUT = process.env.OUT || '/tmp/exp-divergence';
const MAXDIM = 1600;
const name = process.argv[2] || 'bro-03';
const jpg = path.join(MAPS_DIR, name + '.jpg');

// --------------------------- BMP bridge (sips) — copied from realgate.js ---------------------------
function sipsToBMP(jpgPath, maxDim) {
  const tmp = path.join(OUT, '_in.bmp');
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

// --------------------------- resize filters (the ONLY variable under test) ---------------------------
// point: nearest-neighbor — worst-case aliasing, bounds how bad a "wrong" filter looks.
function resizePoint(src, dw, dh) {
  const { width: sw, height: sh, data: sd } = src;
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * sh / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * sw / dw));
      const si = (sy * sw + sx) * 4, di = (y * dw + x) * 4;
      out[di] = sd[si]; out[di + 1] = sd[si + 1]; out[di + 2] = sd[si + 2]; out[di + 3] = 255;
    }
  }
  return { width: dw, height: dh, data: out };
}
// bilinear-naive: single-tap bilinear at the mapped point — what realgate.js's own
// canvas shim does (and what a naive/cheap drawImage would do). Undersamples on a
// >1x downscale: it skips most source pixels instead of averaging them.
function resizeBilinear(src, dw, dh) {
  const { width: sw, height: sh, data: sd } = src;
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sh / dh - 0.5));
    const y0 = sy | 0, y1 = Math.min(sh - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sw / dw - 0.5));
      const x0 = sx | 0, x1 = Math.min(sw - 1, x0 + 1), fx = sx - x0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const di = (y * dw + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx;
        const bot = sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx;
        out[di + c] = top * (1 - fy) + bot * fy;
      }
      out[di + 3] = 255;
    }
  }
  return { width: dw, height: dh, data: out };
}
// box/area-average: proper downsample — averages every source pixel in each dest
// cell's footprint. What a quality-conscious resampler (ImageIO thumbnailing,
// Lanczos/mipmap canvas backends) approximates for a >1.5x downscale.
function resizeBox(src, dw, dh) {
  const { width: sw, height: sh, data: sd } = src;
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor(y * sh / dh), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * sh / dh));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x * sw / dw), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * sw / dw));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1 && sy < sh; sy++)
        for (let sx = sx0; sx < sx1 && sx < sw; sx++) {
          const si = (sy * sw + sx) * 4; r += sd[si]; g += sd[si + 1]; b += sd[si + 2]; n++;
        }
      const di = (y * dw + x) * 4;
      out[di] = r / n; out[di + 1] = g / n; out[di + 2] = b / n; out[di + 3] = 255;
    }
  }
  return { width: dw, height: dh, data: out };
}

// --------------------------- canvas shim (identity-only; resize already done) ---------------------------
function makeCanvas(w, h, imgData) {
  const cv = { _img: imgData || { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } };
  Object.defineProperty(cv, 'width', { get() { return cv._img.width; }, set(v) { cv._img = { width: v, height: cv._img.height, data: new Uint8ClampedArray(Math.max(0, v * cv._img.height * 4)) }; } });
  Object.defineProperty(cv, 'height', { get() { return cv._img.height; }, set(v) { cv._img = { width: cv._img.width, height: v, data: new Uint8ClampedArray(Math.max(0, cv._img.width * v * 4)) }; } });
  const ident = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  let M = ident();
  const ctx = {
    canvas: cv, fillStyle: '#fff', strokeStyle: '#000', lineWidth: 1,
    save() { this._saved = { ...M }; }, restore() { if (this._saved) M = this._saved; },
    translate(tx, ty) { M = { ...M, e: M.a * tx + M.c * ty + M.e, f: M.b * tx + M.d * ty + M.f }; },
    rotate(t) { const c = Math.cos(t), s = Math.sin(t); M = { a: M.a * c + M.c * s, b: M.b * c + M.d * s, c: -M.a * s + M.c * c, d: -M.b * s + M.d * c, e: M.e, f: M.f }; },
    fillRect(x0, y0, fw, fh) {
      const d = cv._img.data, W = cv.width, H = cv.height;
      if (x0 === undefined) { x0 = 0; y0 = 0; fw = W; fh = H; }
      for (let y = Math.max(0, y0 | 0); y < Math.min(H, y0 + fh); y++)
        for (let x = Math.max(0, x0 | 0); x < Math.min(W, x0 + fw); x++) { const i = (y * W + x) * 4; d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = 255; }
    },
    drawImage(src, dx, dy, dw, dh) {
      const simg = src._img, sw = simg.width, sh = simg.height;
      if (dw === undefined) { dw = sw; dh = sh; }
      const W = cv.width, H = cv.height, d = cv._img.data, sd = simg.data;
      const isIdent = M.a === 1 && M.b === 0 && M.c === 0 && M.d === 1 && M.e === 0 && M.f === 0;
      if (isIdent) {
        for (let y = 0; y < dh; y++) {
          const oy = (dy | 0) + y; if (oy < 0 || oy >= H) continue;
          const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sh / dh - 0.5));
          for (let x = 0; x < dw; x++) {
            const ox = (dx | 0) + x; if (ox < 0 || ox >= W) continue;
            const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sw / dw - 0.5));
            const x0 = sx | 0, y0 = sy | 0, x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
            const fx = sx - x0, fy = sy - y0;
            const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
            const o = (oy * W + ox) * 4;
            for (let c = 0; c < 3; c++) { const top = sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx; const bot = sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx; d[o + c] = top * (1 - fy) + bot * fy; }
            d[o + 3] = 255;
          }
        }
        return;
      }
      const det = M.a * M.d - M.b * M.c;
      const ia = M.d / det, ib = -M.b / det, ic = -M.c / det, id = M.a / det;
      const ie = -(ia * M.e + ic * M.f), iff = -(ib * M.e + id * M.f);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const ux = ia * x + ic * y + ie - dx, uy = ib * x + id * y + iff - dy;
        const sx = ux * sw / dw, sy = uy * sh / dh;
        if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) continue;
        const x0 = sx | 0, y0 = sy | 0, x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
        const fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        const o = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) { const top = sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx; const bot = sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx; d[o + c] = top * (1 - fy) + bot * fy; }
        d[o + 3] = 255;
      }
    },
    getImageData(x, y, gw, gh) {
      const W = cv.width;
      if (x === 0 && y === 0 && gw === W && gh === cv.height) return { width: gw, height: gh, data: new Uint8ClampedArray(cv._img.data) };
      const out = new Uint8ClampedArray(gw * gh * 4);
      for (let yy = 0; yy < gh; yy++) for (let xx = 0; xx < gw; xx++) { const si = ((y + yy) * W + (x + xx)) * 4, di = (yy * gw + xx) * 4; out[di] = cv._img.data[si]; out[di + 1] = cv._img.data[si + 1]; out[di + 2] = cv._img.data[si + 2]; out[di + 3] = cv._img.data[si + 3]; }
      return { width: gw, height: gh, data: out };
    },
    createImageData(w2, h2) { return { width: w2, height: h2, data: new Uint8ClampedArray(w2 * h2 * 4) }; },
    putImageData(img, x, y) { cv._img = img; },
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {},
  };
  cv.getContext = () => ctx;
  return cv;
}

// --------------------------- load renderer modules ---------------------------
global.window = {};
global.document = { createElement: () => makeCanvas(1, 1) };
for (const mod of ['digitize.js', 'perspective.js', 'rectify.js', 'grid.js']) {
  eval(fs.readFileSync(path.join(ROOT, 'renderer', mod), 'utf8'));
}
const DS = window.DS;

function runPipeline(imgData, label) {
  const work0 = makeCanvas(imgData.width, imgData.height, imgData);
  const rect = DS.perspective.autoRectify(work0);
  let work = rect.canvas;
  const de = DS.smartDeskew(work); work = de.canvas;
  const W = work.width, H = work.height;
  const gray = DS.toGray(work.getContext('2d').getImageData(0, 0, W, H));
  const est = DS.estimateGrid(gray, W, H);
  return { label, s: est.s, C: est.C, R: est.R, conf: +est.confidence.toFixed(2), W, H, rect: rect.applied, deskew: +de.angle.toFixed(2) };
}

// --------------------------- main ---------------------------
fs.mkdirSync(OUT, { recursive: true });
console.log(`=== ${name}.jpg — resize-filter sensitivity of estimateGrid ===`);

// A) node gate baseline: sips does decode+resize in ONE step (-Z MAXDIM).
const gateRaw = sipsToBMP(jpg, MAXDIM);
const rA = runPipeline(gateRaw, 'A) sips -Z 1600 (node gate, current)');

// Full-res decode (no -Z) — this is what every <img>-based surface starts from;
// the browser/WKWebView JS then does its OWN resize via canvas drawImage.
const fullRaw = sipsToBMP(jpg, null);
const targetW = Math.round(fullRaw.width * Math.min(1, MAXDIM / Math.max(fullRaw.width, fullRaw.height)));
const targetH = Math.round(fullRaw.height * Math.min(1, MAXDIM / Math.max(fullRaw.width, fullRaw.height)));
console.log(`full-res decode: ${fullRaw.width}x${fullRaw.height}  ->  target working size ${targetW}x${targetH} (same Math.round(scale) as setupImage())`);

// B) full-res decode, then JS-side NAIVE single-tap bilinear resize — same filter
//    realgate.js's OWN canvas shim uses inside drawImage. Stand-in for a
//    canvas backend that does NOT box-filter a >1x downscale.
const rB = runPipeline(resizeBilinear(fullRaw, targetW, targetH), 'B) full-res -> JS naive-bilinear resize');

// C) full-res decode, then nearest-neighbor resize — worst case, bounds the spread.
const rC = runPipeline(resizePoint(fullRaw, targetW, targetH), 'C) full-res -> nearest-neighbor resize');

// D) full-res decode, then proper box/area-average resize — stand-in for a
//    quality-conscious resampler (ImageIO thumbnailing, Lanczos/mipmap canvas backend).
const rD = runPipeline(resizeBox(fullRaw, targetW, targetH), 'D) full-res -> box/area-average resize');

const rows = [rA, rB, rC, rD];
for (const r of rows) console.log(`${r.label.padEnd(42)} s=${r.s}  C=${r.C} R=${r.R} conf=${r.conf}  work=${r.W}x${r.H}  rect=${r.rect} deskew=${r.deskew}°`);

console.log(`\nspread across resize filters alone: ${Math.min(...rows.map(r => r.s))}–${Math.max(...rows.map(r => r.s))} (node gate=${rA.s}, target range from live divergence: 41/42/44)`);
fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(rows, null, 2));
