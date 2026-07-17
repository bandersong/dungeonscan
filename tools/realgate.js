/*
 * Headless real-map regression gate. Runs the app's EXACT import pipeline
 * (scale→MAXDIM → autoRectify → smartDeskew → estimateGrid → detectWalls →
 * gridDrawn branch → floor → doors) on datasets/real-maps/*.jpg under plain
 * Node — no browser, no native deps. JPEG decode is delegated to macOS `sips`
 * (JPEG → uncompressed BMP, parsed here); output overlays are written as BMP
 * and converted to PNG with `sips` for eyeballing.
 *
 *   node tools/realgate.js            all maps, table + overlays
 *   node tools/realgate.js bro-03     one map
 *   OUT=/path node tools/realgate.js  overlay output dir (default /tmp/realgate)
 *
 * Exit 0 = every map within tolerance of its frozen expected pitch.
 * Expected pitches are in EXPECT below — px at the post-rectify working scale,
 * frozen by visual verification of the overlays (see docs in the repo).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MAPS_DIR = path.join(ROOT, 'datasets', 'real-maps');
const OUT = process.env.OUT || '/tmp/realgate';
const MAXDIM = 1600;

// Frozen expectations: pitch (px) after rectify at MAXDIM=1600, ±TOL.
// Each value was verified on ZOOMED lattice overlays (2026-07-16): on every map
// the drawn cell pitch equals the printed dot pitch. Low-zoom eyeballs
// repeatedly mis-read these by 2× in both directions — re-verify at zoom before
// ever changing them.
// exp:null = not yet frozen (report-only, never fails the gate).
const EXPECT = { 'bro-01': { exp: 28 }, 'bro-02': { exp: 48 }, 'bro-03': { exp: 41 },
                 'bro-04': { exp: 45 }, 'bro-05': { exp: 40 } };
const TOL = 2;

// --------------------------- BMP bridge (sips) ---------------------------
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
      out[d] = buf[s + 2]; out[d + 1] = buf[s + 1]; out[d + 2] = buf[s]; // BGR→RGB
      out[d + 3] = bytes === 4 ? buf[s + 3] : 255;
    }
  }
  return { width: w, height: h, data: out };
}
function writeBMP(img, file) {
  const { width: w, height: h, data } = img;
  const stride = Math.floor((w * 24 + 31) / 32) * 4;
  const size = 54 + stride * h;
  const buf = Buffer.alloc(size);
  buf.writeUInt16LE(0x4d42, 0); buf.writeUInt32LE(size, 2); buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14); buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28);
  for (let y = 0; y < h; y++) {
    let s = y * w * 4;
    let d = 54 + (h - 1 - y) * stride;
    for (let x = 0; x < w; x++, s += 4, d += 3) {
      buf[d] = data[s + 2]; buf[d + 1] = data[s + 1]; buf[d + 2] = data[s];
    }
  }
  fs.writeFileSync(file, buf);
}
function saveOverlayPng(img, name) {
  const bmp = path.join(OUT, name + '.bmp');
  writeBMP(img, bmp);
  execFileSync('sips', ['-s', 'format', 'png', bmp, '--out', path.join(OUT, name + '.png')], { stdio: 'ignore' });
  fs.unlinkSync(bmp);
}

// --------------------------- canvas shim ---------------------------
// Enough 2D canvas for digitize/perspective/rectify/grid: pixel IO, scaling
// drawImage, and the translate/rotate/drawImage combo rotateCanvas uses
// (implemented as inverse-mapped bilinear sampling of an affine transform).
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
        // pure scale blit (bilinear)
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
      // affine path: inverse-map every dest pixel through M
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
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {}, // overlays drawn manually
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

// --------------------------- load renderer modules ---------------------------
global.window = {};
global.document = { createElement: () => makeCanvas(1, 1) };
for (const mod of ['digitize.js', 'perspective.js', 'rectify.js', 'grid.js']) {
  eval(fs.readFileSync(path.join(ROOT, 'renderer', mod), 'utf8'));
}
const DS = window.DS;

// --------------------------- overlay painting (manual, no canvas paths) ---------------------------
function paintLattice(img, est, rgb) {
  const { width: W, height: H, data: d } = img;
  const lw = Math.max(1, Math.round(est.s * 0.04));
  function px(x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4; d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2];
  }
  for (let c = 0; c <= est.C; c++) {
    const X = Math.round(est.ox + c * est.s);
    for (let y = Math.round(est.oy); y <= est.oy + est.R * est.s; y++)
      for (let t = 0; t < lw; t++) px(X + t, y);
  }
  for (let r = 0; r <= est.R; r++) {
    const Y = Math.round(est.oy + r * est.s);
    for (let x = Math.round(est.ox); x <= est.ox + est.C * est.s; x++)
      for (let t = 0; t < lw; t++) px(x, Y + t);
  }
}

// --------------------------- pipeline per map ---------------------------
function runMap(name) {
  const jpg = path.join(MAPS_DIR, name + '.jpg');
  const raw = jpegToImageData(jpg, MAXDIM); // sips -Z == app's MAXDIM fit
  const work0 = makeCanvas(raw.width, raw.height);
  work0._img = { width: raw.width, height: raw.height, data: raw.data };

  const rect = DS.perspective.autoRectify(work0);
  let work = rect.canvas;
  const de = DS.smartDeskew(work); work = de.canvas;
  const W = work.width, H = work.height;
  const gray = DS.toGray(work.getContext('2d').getImageData(0, 0, W, H));
  const est = DS.estimateGrid(gray, W, H);

  const grid = { s: est.s, ox: est.ox, oy: est.oy, C: est.C, R: est.R };
  const edge = DS.detectWalls(gray, W, H, grid);
  const gridDrawn = DS.gridDrawnScore(edge) > 0.5;
  let walls, floor;
  if (gridDrawn) { const cf = DS.detectFloorByInk(gray, W, H, grid); walls = cf.walls; floor = cf.floor; }
  else { walls = edge; floor = DS.detectFloor(edge); }
  const floorN = floor.reduce((a, b) => a + b, 0);

  // overlay: rectified photo + detected lattice
  const shot = work.getContext('2d').getImageData(0, 0, W, H);
  if (process.env.SAVE_RECT) saveOverlayPng(shot, name + '-rect'); // clean rectified copy
  paintLattice(shot, est, [40, 220, 90]);
  saveOverlayPng(shot, name + '-grid');

  return {
    name, W, H, rectified: rect.applied, rectReason: rect.reason,
    deskew: +de.angle.toFixed(2), s: est.s, conf: +est.confidence.toFixed(2),
    gridDrawn, floorN, dbg: est.dbg,
  };
}

// --------------------------- main ---------------------------
fs.mkdirSync(OUT, { recursive: true });
const which = process.argv[2];
const names = which ? [which] : Object.keys(EXPECT);
let fails = 0;
const rows = [];
for (const n of names) {
  try {
    const r = runMap(n);
    const exp = EXPECT[n] && EXPECT[n].exp;
    let verdict = 'REPORT';
    if (exp != null) {
      const ok = Math.abs(r.s - exp) <= TOL;
      verdict = ok ? 'PASS' : 'FAIL';
      if (!ok) fails++;
    }
    rows.push({ ...r, exp, verdict });
    console.log(`${n}: s=${r.s} exp=${exp == null ? '—' : exp} ${verdict}  conf=${r.conf} rect=${r.rectified ? 'Y' : r.rectReason} deskew=${r.deskew}° gridDrawn=${r.gridDrawn} floor=${r.floorN}`);
    console.log(`   dbg sX=${r.dbg.sX} sY=${r.dbg.sY} halved=[${r.dbg.halved}] prom=[${r.dbg.prom.map((v) => v.toFixed(2))}] halfRatio=[${r.dbg.halfRatio.map((v) => v.toFixed(2))}] midRatio=[${r.dbg.midRatio.map((v) => v.toFixed(2))}] reg=[${r.dbg.reg.map((v) => v.toFixed(2))}]`);
  } catch (e) {
    fails++;
    console.log(`${n}: ERROR ${e.message}`);
  }
}
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(rows, null, 2));
console.log(`\noverlays + results.json → ${OUT}`);
process.exit(fails ? 1 : 0);
