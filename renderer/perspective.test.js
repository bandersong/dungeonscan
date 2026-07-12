/*
 * Verification for renderer/perspective.js. Runs headlessly under plain Node
 * with a tiny canvas shim (no native deps): correct() only needs
 * getImageData/createImageData/putImageData, and autoDetectPage() needs a
 * downscaling drawImage + fillRect on top of that.
 *
 * Two checks:
 *   A. MATH     — solveHomography maps rect corners to the quad exactly and
 *                 inverts cleanly (8×8 solve is correct, ~1e-9 residual).
 *   B. IMAGE    — forward-warp a known rectangle (projective keystone) to make
 *                 a "photo", correct() it back, and confirm interior straight
 *                 lines come out straight and at the right place. Prints the
 *                 worst positional error in px.
 *   C. DETECT   — autoDetectPage() on a clean page-on-dark image returns a quad
 *                 close to the true rectangle corners.
 *
 *   node renderer/perspective.test.js   (exit 0 = pass)
 */
'use strict';
const fs = require('fs');
const path = require('path');

// --------------------------- canvas shim ---------------------------
function parseColor(c) {
  if (c === '#fff' || c === '#ffffff') return [255, 255, 255];
  if (c === '#000' || c === '#000000') return [0, 0, 0];
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  return [255, 255, 255];
}
function makeCanvas(w, h) {
  // width/height are accessors: assigning either one reallocates the backing
  // buffer (a real canvas clears its surface on any dimension change), so code
  // that does createElement → set w/h → drawImage works correctly.
  const cv = { _img: { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } };
  Object.defineProperty(cv, 'width', { get() { return cv._img.width; }, set(v) { cv._img = { width: v, height: cv._img.height, data: new Uint8ClampedArray(v * cv._img.height * 4) }; } });
  Object.defineProperty(cv, 'height', { get() { return cv._img.height; }, set(v) { cv._img = { width: cv._img.width, height: v, data: new Uint8ClampedArray(cv._img.width * v * 4) }; } });
  cv.getContext = () => ({
    fillStyle: '#fff',
    fillRect() { const [r, g, b] = parseColor(this.fillStyle); const d = cv._img.data; for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; } },
    // nearest-neighbour blit (autoDetectPage only ever downscales the full src).
    drawImage(src, dx, dy, dw, dh) {
      const sd = src._img.data, sw = src.width, sh = src.height;
      const d = cv._img.data;
      for (let y = 0; y < cv.height; y++) {
        const sy = Math.min(sh - 1, Math.floor(y / cv.height * sh));
        for (let xi = 0; xi < cv.width; xi++) {
          const sx = Math.min(sw - 1, Math.floor(xi / cv.width * sw));
          const si = (sy * sw + sx) * 4, di = (y * cv.width + xi) * 4;
          d[di] = sd[si]; d[di + 1] = sd[si + 1]; d[di + 2] = sd[si + 2]; d[di + 3] = sd[si + 3];
        }
      }
    },
    getImageData() { return { width: cv.width, height: cv.height, data: new Uint8ClampedArray(cv._img.data) }; },
    createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData(img) { cv._img = img; },
  });
  return cv;
}
global.window = {};
global.document = { createElement: (t) => makeCanvas(1, 1) };

// Load the module (IIFE attaches window.DS.perspective).
const code = fs.readFileSync(path.join(__dirname, 'perspective.js'), 'utf8');
eval(code);
const { correct, autoDetectPage, solveHomography } = window.DS.perspective;

// --------------------------- helpers ---------------------------
function applyH(H, x, y) { // H=[h0..h7], 9th=1
  const d = H[6] * x + H[7] * y + 1;
  return { x: (H[0] * x + H[1] * y + H[2]) / d, y: (H[3] * x + H[4] * y + H[5]) / d };
}
function setPx(img, w, x, y, r, g, b) { const i = (y * w + x) * 4; const d = img.data; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; }
function sampleOrig(orig, ox, oy) { // bilinear, out of bounds = white
  const w = orig.width, h = orig.height, d = orig.data;
  if (ox < 0 || oy < 0 || ox > w - 1 || oy > h - 1) return [255, 255, 255];
  const x0 = ox | 0, y0 = oy | 0, x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = ox - x0, fy = oy - y0, i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = d[i00 + c] * (1 - fx) + d[i10 + c] * fx, bot = d[i01 + c] * (1 - fx) + d[i11 + c] * fx;
    out[c] = top * (1 - fy) + bot * fy;
  }
  return out;
}

let failures = 0;
function assert(ok, msg) { if (!ok) { failures++; console.log('  FAIL: ' + msg); } else console.log('  ok:   ' + msg); }

// --------------------------- A. math ---------------------------
console.log('\n[A] homography solve — exactness & invertibility');
{
  const W = 300, H = 300;
  const D = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  const Q = [{ x: 60, y: 40 }, { x: 440, y: 20 }, { x: 480, y: 360 }, { x: 40, y: 380 }];
  const Hf = solveHomography(D, Q);        // D -> Q  (forward warp)
  const Hb = solveHomography(Q, D);        // Q -> D  (its inverse)
  // 1. forward maps each rect corner exactly onto its quad corner
  let e1 = 0;
  for (let i = 0; i < 4; i++) { const p = applyH(Hf, D[i].x, D[i].y); e1 = Math.max(e1, Math.hypot(p.x - Q[i].x, p.y - Q[i].y)); }
  assert(e1 < 1e-9, `rect→quad corners exact (max err ${e1.toExponential(2)} px)`);
  // 2. compose forward then inverse = identity across a grid
  let e2 = 0;
  for (let gx = 0; gx <= W; gx += 30) for (let gy = 0; gy <= H; gy += 30) {
    const a = applyH(Hf, gx, gy), b = applyH(Hb, a.x, a.y);
    e2 = Math.max(e2, Math.hypot(b.x - gx, b.y - gy));
  }
  assert(e2 < 1e-9, `H∘H⁻¹ = identity on 11×11 grid (max err ${e2.toExponential(2)} px)`);
  // 3. singular input (collinear corners) returns null, not garbage
  const bad = solveHomography(D, [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }]);
  assert(bad === null, 'degenerate (collinear) quad → null, no throw');
}

// --------------------------- B. image round-trip ---------------------------
console.log('\n[B] forward-warp known rectangle → correct() back (interior straightness)');
let maxLineErr = 0;
{
  const W = 300, H = 300;
  const D = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  const Q = [{ x: 60, y: 40 }, { x: 440, y: 20 }, { x: 480, y: 360 }, { x: 40, y: 380 }];
  const Hf = solveHomography(D, Q); // page → photo
  const Hb = solveHomography(Q, D); // photo → page (for inverse-sampling the warp)

  // Orig: white page with thin black guide lines at known positions.
  const origCv = makeCanvas(W, H); origCv.getContext().fillRect();
  const orig = origCv._img;
  const vLines = [60, 150, 240], hLines = [60, 150, 240];
  for (const xk of vLines) for (let y = 0; y < H; y++) { setPx(orig, W, xk, y, 0, 0, 0); setPx(orig, W, xk + 1, y, 0, 0, 0); }
  for (const yk of hLines) for (let x = 0; x < W; x++) { setPx(orig, W, x, yk, 0, 0, 0); setPx(orig, W, x, yk + 1, 0, 0, 0); }

  // Photo: inverse-sample Orig through Hb (the keystone "photo"). Quad fits in ~520×420.
  const PW = 520, PH = 420;
  const photoCv = makeCanvas(PW, PH); const photo = photoCv._img.data; photo.fill(255);
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    const p = applyH(Hb, x, y); const c = sampleOrig(orig, p.x, p.y); const i = (y * PW + x) * 4;
    photo[i] = c[0]; photo[i + 1] = c[1]; photo[i + 2] = c[2]; photo[i + 3] = 255;
  }

  // Correct the photo using the (known) quad corners.
  const corr = correct(photoCv, Q);
  const cw = corr.width, ch = corr.height, cd = corr._img.data;
  console.log(`  corrected frame ${cw}×${ch}`);

  // After correction, a page point (px,py) lands at (px*cw/W, py*ch/H) — verify
  // the guide lines are straight and at the expected position.
  function darkestColInBand(row, cx, half) {
    let bx = -1, bv = 256;
    for (let xi = Math.max(0, Math.floor(cx - half)); xi <= Math.min(cw - 1, Math.ceil(cx + half)); xi++) {
      const i = (row * cw + xi) * 4, v = cd[i] + cd[i + 1] + cd[i + 2];
      if (v < bv) { bv = v; bx = xi; }
    }
    return bx;
  }
  for (const xk of vLines) {
    const exp = xk * cw / W, xs = [];
    for (let y = 8; y < ch - 8; y += 4) { const c = darkestColInBand(y, exp, 14); if (c >= 0) xs.push(c); }
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length);
    const err = Math.abs(mean - exp);
    maxLineErr = Math.max(maxLineErr, err);
    console.log(`  v-line x=${xk}: expected ${exp.toFixed(2)} got ${mean.toFixed(2)} (σ=${sd.toFixed(2)}px, |Δ|=${err.toFixed(2)}px)`);
    assert(err < 2.0 && sd < 1.5, `vertical line x=${xk} straight & placed (Δ=${err.toFixed(2)}px, σ=${sd.toFixed(2)}px)`);
  }
  function darkestRowInBand(col, cy, half) {
    let by = -1, bv = 256;
    for (let yi = Math.max(0, Math.floor(cy - half)); yi <= Math.min(ch - 1, Math.ceil(cy + half)); yi++) {
      const i = (yi * cw + col) * 4, v = cd[i] + cd[i + 1] + cd[i + 2];
      if (v < bv) { bv = v; by = yi; }
    }
    return by;
  }
  for (const yk of hLines) {
    const exp = yk * ch / H, ys = [];
    for (let x = 8; x < cw - 8; x += 4) { const r = darkestRowInBand(x, exp, 14); if (r >= 0) ys.push(r); }
    const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
    const sd = Math.sqrt(ys.reduce((a, b) => a + (b - mean) * (b - mean), 0) / ys.length);
    const err = Math.abs(mean - exp);
    maxLineErr = Math.max(maxLineErr, err);
    console.log(`  h-line y=${yk}: expected ${exp.toFixed(2)} got ${mean.toFixed(2)} (σ=${sd.toFixed(2)}px, |Δ|=${err.toFixed(2)}px)`);
    assert(err < 2.0 && sd < 1.5, `horizontal line y=${yk} straight & placed (Δ=${err.toFixed(2)}px, σ=${sd.toFixed(2)}px)`);
  }
}

// --------------------------- C. autoDetectPage ---------------------------
console.log('\n[C] autoDetectPage — clean page on dark background');
{
  const W = 400, H = 400;
  const cv = makeCanvas(W, H); const ctx = cv.getContext();
  ctx.fillStyle = '#000'; ctx.fillRect();            // dark desk
  const img = cv._img;
  const px0 = 90, py0 = 70, px1 = 330, py1 = 300;    // an off-centre white page
  for (let y = py0; y < py1; y++) for (let x = px0; x < px1; x++) setPx(img, W, x, y, 255, 255, 255);
  // a little ink inside so contrast mask is non-empty too
  for (let y = 150; y < 160; y++) for (let x = 150; x < 280; x++) setPx(img, W, x, y, 60, 60, 60);

  const quad = autoDetectPage(cv);
  let maxErr = 0;
  const truth = [{ x: px0, y: py0 }, { x: px1, y: py0 }, { x: px1, y: py1 }, { x: px0, y: py1 }];
  quad.forEach((p, i) => {
    const e = Math.hypot(p.x - truth[i].x, p.y - truth[i].y);
    maxErr = Math.max(maxErr, e);
    console.log(`  corner ${['TL', 'TR', 'BR', 'BL'][i]}: got (${p.x.toFixed(1)},${p.y.toFixed(1)}) truth (${truth[i].x},${truth[i].y}) → ${e.toFixed(1)}px`);
  });
  assert(quad.length === 4, 'returned 4 corners');
  assert(maxErr < 12, `page quad within 12px of truth (max ${maxErr.toFixed(1)}px)`);
}

// --------------------------- summary ---------------------------
console.log('\n────────────────────────────────────────');
console.log(`B: worst interior line error = ${maxLineErr.toFixed(2)} px`);
console.log(failures === 0 ? 'RESULT: PASS ✅' : `RESULT: FAIL ❌ (${failures} assertion(s))`);
process.exit(failures === 0 ? 0 : 1);
