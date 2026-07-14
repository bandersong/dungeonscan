/*
 * Auto-deskew for real photos. A handheld photo of a flat page is usually a few
 * degrees rotated; the wall/grid detector assumes axis-aligned lines, so we
 * straighten first. Classic projection-profile method: the true rotation is the
 * angle whose horizontal+vertical ink projections are the "peakiest" (lines line
 * up with rows/columns). Cheap because we score on a downscaled copy.
 */
(function () {
  'use strict';

  function downscaleGray(src, maxDim) {
    const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
    const w = Math.max(8, Math.round(src.width * scale)), h = Math.max(8, Math.round(src.height * scale));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(src, 0, 0, w, h);
    return c;
  }

  // variance of a projection profile (higher = sharper periodic lines)
  function projScore(gray, w, h) {
    const col = new Float64Array(w), row = new Float64Array(h);
    for (let y = 0; y < h; y++) { const b = y * w; for (let x = 0; x < w; x++) { const ink = 255 - gray[b + x]; col[x] += ink; row[y] += ink; } }
    const varc = variance(col), varr = variance(row);
    return varc + varr;
  }
  function variance(a) { let m = 0; for (let i = 0; i < a.length; i++) m += a[i]; m /= a.length; let v = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - m; v += d * d; } return v / a.length; }

  // ---- BUG B: projection-variance deskew (pitch-independent, robust) ----
  // The true page rotation maximizes the peakiness of the row + column ink projections:
  // when the ruled grid is axis-aligned, lines pile ink onto specific rows/columns and the
  // projections go spiky. We score V(a) = var(highpass(row proj)) + var(highpass(col proj))
  // over an angle sweep on a downscaled grayscale copy. Isotropic dots / hatch do NOT make
  // a spurious variance peak, so a straight map stays at 0°. Pure JS (no canvas) so it runs
  // identically in node and the browser; smartDeskew applies the chosen angle to the
  // full-res canvas once. This REPLACES the old estimateGrid-confidence / dot-angle sweep,
  // which was gameable (diagonal aliasing faked high confidence).

  // box-downscale a grayscale array so its long side is ~maxDim
  function downscaleArray(gray, W, H, maxDim) {
    const sc = Math.min(1, maxDim / Math.max(W, H));
    const w = Math.max(8, Math.round(W * sc)), h = Math.max(8, Math.round(H * sc));
    const out = new Uint8Array(w * h), sx0 = W / w, sy0 = H / h;
    for (let y = 0; y < h; y++) {
      const syi = Math.floor(y * sy0), syj = Math.min(H, Math.floor((y + 1) * sy0));
      for (let x = 0; x < w; x++) {
        const sxi = Math.floor(x * sx0), sxj = Math.min(W, Math.floor((x + 1) * sx0));
        let sum = 0, cnt = 0;
        for (let yy = syi; yy < syj; yy++) for (let xx = sxi; xx < sxj; xx++) { sum += gray[yy * W + xx]; cnt++; }
        out[y * w + x] = cnt ? (sum / cnt) | 0 : 255;
      }
    }
    return { data: out, w, h };
  }

  // nearest-neighbour rotate of a grayscale array about its centre, white (255) fill
  function rotateArrayNN(g, w, h, deg) {
    const rad = deg * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
    const cx = w / 2, cy = h / 2;
    const out = new Uint8Array(w * h).fill(255);
    for (let y = 0; y < h; y++) {
      const dy = y - cy, brow = y * w;
      for (let x = 0; x < w; x++) {
        const dx = x - cx;
        // inverse rotation: source pixel = R(-deg) of the displacement from centre
        const sx = (cx + c * dx + s * dy) | 0;
        const sy = (cy - s * dx + c * dy) | 0;
        if (sx >= 0 && sx < w && sy >= 0 && sy < h) out[brow + x] = g[sy * w + sx];
      }
    }
    return out;
  }

  // variance of a signal after subtracting a ~win-sample moving average (kills the slow
  // lighting gradient so only line-driven peakiness remains). Mutates sig in place.
  function hpVariance(sig, win) {
    const n = sig.length, ma = new Float64Array(n);
    for (let i = 0; i < n; i++) { let sum = 0, cnt = 0; for (let d = -win; d <= win; d++) { const j = i + d; if (j >= 0 && j < n) { sum += sig[j]; cnt++; } } ma[i] = sum / cnt; }
    let m = 0; for (let i = 0; i < n; i++) { sig[i] -= ma[i]; m += sig[i]; } m /= n;
    let v = 0; for (let i = 0; i < n; i++) { const d = sig[i] - m; v += d * d; } return v / n;
  }

  // V(a) = var(highpass(row ink projection)) + var(highpass(col ink projection))
  function projVariance(g, w, h) {
    const row = new Float64Array(h), col = new Float64Array(w);
    for (let y = 0; y < h; y++) { const b = y * w; for (let x = 0; x < w; x++) { const ink = 255 - g[b + x]; row[y] += ink; col[x] += ink; } }
    return hpVariance(row, 25) + hpVariance(col, 25);
  }

  // Choose a deskew angle by projection variance. Returns { angle, V0, Vstar, ratio }.
  // angle = a* (argmax V), accepted only if V(a*) >= 1.08 * V(0) (an 8% real gain);
  // otherwise 0°. Among angles within 1% of the peak, the smallest |a| wins, so a straight
  // map never gets rotated away from true and a genuinely angled map still locks on.
  function projectionVarianceAngle(gray, W, H, opts) {
    opts = opts || {};
    const { data, w, h } = downscaleArray(gray, W, H, opts.maxDim || 1000);
    const range = 25, step = 0.5, pts = [];
    for (let a = -range; a <= range + 1e-9; a += step) {
      const g = (Math.abs(a) < 0.01) ? data : rotateArrayNN(data, w, h, a);
      pts.push({ a, V: projVariance(g, w, h) });
    }
    const V0 = pts.find(p => p.a === 0).V;
    let peak = pts[0]; for (const p of pts) if (p.V > peak.V) peak = p;
    if (peak.V < 1.08 * V0) return { angle: 0, V0, Vstar: V0, ratio: 1 };
    const near = pts.filter(p => p.V >= 0.99 * peak.V).sort((p, q) => Math.abs(p.a) - Math.abs(q.a));
    return { angle: near[0].a, V0, Vstar: peak.V, ratio: peak.V / V0 };
  }

  function rotatedGray(small, angleDeg) {
    const w = small.width, h = small.height;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
    x.translate(w / 2, h / 2); x.rotate(angleDeg * Math.PI / 180); x.translate(-w / 2, -h / 2);
    x.drawImage(small, 0, 0);
    const img = x.getImageData(0, 0, w, h);
    return window.DS.toGray(img);
  }

  // Returns { angle, canvas } — canvas is the full-res source rotated to deskew.
  function autoDeskew(src, opts) {
    opts = opts || {};
    const range = opts.range || 8, step = opts.step || 0.5;
    const small = downscaleGray(src, 360);
    const w = small.width, h = small.height;
    let best = 0, bestScore = -Infinity;
    for (let a = -range; a <= range; a += step) {
      const g = rotatedGray(small, a);
      const sc = projScore(g, w, h);
      if (sc > bestScore) { bestScore = sc; best = a; }
    }
    // refine around best at finer step
    for (let a = best - step; a <= best + step; a += step / 4) {
      const g = rotatedGray(small, a);
      const sc = projScore(g, w, h);
      if (sc > bestScore) { bestScore = sc; best = a; }
    }
    if (Math.abs(best) < 0.25) return { angle: 0, canvas: src };
    // rotate full-res
    const out = document.createElement('canvas'); out.width = src.width; out.height = src.height;
    const x = out.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, out.width, out.height);
    x.translate(out.width / 2, out.height / 2); x.rotate(best * Math.PI / 180); x.translate(-out.width / 2, -out.height / 2);
    x.drawImage(src, 0, 0);
    return { angle: best, canvas: out };
  }

  // ---- dot-lattice orientation (Moleskine dot grid) ----
  // The printed dot grid is a clean periodic lattice that survives even under heavy
  // hatching, because the dots are light-GRAY isolated points while the drawing is
  // near-black marker. Isolate them with a gray BAND, then read the dominant
  // nearest-neighbour direction — that's the page/grid rotation, recoverable even
  // when the drawn lines are too broken to deskew from (the projection method fails
  // on hand-drawn hatched maps). Returns { angle:(-45,45], dots }; angle 0 if too few.
  function detectDotAngle(gray, w, h) {
    const n = w * h;
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[gray[i]]++;
    let cum = 0, p90 = 230;
    for (let i = 0; i < 256; i++) { cum += hist[i]; if (cum >= 0.9 * n) { p90 = i; break; } }
    const lo = Math.max(60, p90 - 120), hi = p90 - 25;
    if (hi <= lo) return { angle: 0, dots: 0 };
    const on = new Uint8Array(n);
    for (let i = 0; i < n; i++) on[i] = (gray[i] >= lo && gray[i] <= hi) ? 1 : 0;
    // connected components; keep small, roughly-square, filled blobs = printed dots
    const lab = new Int32Array(n), stack = new Int32Array(n), dots = [];
    let cur = 0;
    for (let i = 0; i < n; i++) {
      if (!on[i] || lab[i]) continue;
      cur++; let sp = 0; stack[sp++] = i; lab[i] = cur;
      let area = 0, mnx = w, mxx = 0, mny = h, mxy = 0, sx = 0, sy = 0;
      while (sp > 0) {
        const p = stack[--sp], x = p % w, y = (p / w) | 0;
        area++; sx += x; sy += y;
        if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y;
        if (x > 0 && on[p - 1] && !lab[p - 1]) { lab[p - 1] = cur; stack[sp++] = p - 1; }
        if (x < w - 1 && on[p + 1] && !lab[p + 1]) { lab[p + 1] = cur; stack[sp++] = p + 1; }
        if (y > 0 && on[p - w] && !lab[p - w]) { lab[p - w] = cur; stack[sp++] = p - w; }
        if (y < h - 1 && on[p + w] && !lab[p + w]) { lab[p + w] = cur; stack[sp++] = p + w; }
      }
      const bw = mxx - mnx + 1, bh = mxy - mny + 1;
      if (area >= 2 && area <= 10 && bw <= 5 && bh <= 5 && Math.abs(bw - bh) <= 2 && area / (bw * bh) >= 0.5)
        dots.push({ x: sx / area, y: sy / area });
    }
    if (dots.length < 200) return { angle: 0, dots: dots.length };
    // nearest-neighbour vectors via a spatial hash
    const CELL = 28, map = new Map(), key = (gx, gy) => gx * 100003 + gy;
    for (let idx = 0; idx < dots.length; idx++) {
      const k = key((dots[idx].x / CELL) | 0, (dots[idx].y / CELL) | 0);
      let a = map.get(k); if (!a) { a = []; map.set(k, a); } a.push(idx);
    }
    const pairs = [];
    for (let idx = 0; idx < dots.length; idx++) {
      const d = dots[idx], gx = (d.x / CELL) | 0, gy = (d.y / CELL) | 0;
      let best = -1, bd = 1e9;
      for (let ax = -1; ax <= 1; ax++) for (let ay = -1; ay <= 1; ay++) {
        const arr = map.get(key(gx + ax, gy + ay)); if (!arr) continue;
        for (const j of arr) { if (j === idx) continue; const dx = dots[j].x - d.x, dy = dots[j].y - d.y, dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; best = j; } }
      }
      if (best < 0) continue;
      const di = Math.sqrt(bd); if (di < 5 || di > 40) continue;
      pairs.push({ di, dx: dots[best].x - d.x, dy: dots[best].y - d.y });
    }
    if (pairs.length < 80) return { angle: 0, dots: dots.length };
    // dominant NN spacing, then lattice angle from spacing-matched pairs (folded mod 90°)
    const dh = new Float64Array(41);
    for (const p of pairs) dh[Math.min(40, Math.round(p.di))]++;
    let spac = 12; for (let i = 10; i <= 28; i++) if (dh[i] > dh[spac]) spac = i;
    const ah = new Float64Array(90);
    for (const p of pairs) {
      if (p.di < 0.78 * spac || p.di > 1.22 * spac) continue;
      let a = Math.atan2(p.dy, p.dx) * 180 / Math.PI; a = ((a % 90) + 90) % 90;
      ah[Math.round(a) % 90]++;
    }
    const sm = new Float64Array(90);
    for (let i = 0; i < 90; i++) { let s = 0; for (let d = -2; d <= 2; d++) s += ah[((i + d) % 90 + 90) % 90]; sm[i] = s; }
    let pk = 0; for (let i = 1; i < 90; i++) if (sm[i] > sm[pk]) pk = i;
    return { angle: pk < 45 ? pk : pk - 90, dots: dots.length, spacing: spac };
  }

  // Rotate a canvas by `deg` about its centre (white background), returning a new
  // canvas. Sub-degree rotations are a no-op (returns the source).
  function rotateCanvas(src, deg) {
    if (Math.abs(deg) < 0.15) return src;
    const w = src.width, h = src.height;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
    x.translate(w / 2, h / 2); x.rotate(deg * Math.PI / 180); x.translate(-w / 2, -h / 2);
    x.drawImage(src, 0, 0);
    return c;
  }

  // Straighten by projection variance (BUG B). The angle is chosen purely by how peaky
  // the ink projections get — NOT by grid-confidence (gameable) and NOT by the dot lattice
  // (a misdector here). 0° is always available: the angle is accepted only if projection
  // variance beats the upright image by >= 8%, so a straight scan is never rotated away
  // from true. The chosen angle is applied to the full-res canvas once. detectDotAngle is
  // left defined but unused. Returns { canvas, angle, confidence }.
  function smartDeskew(src) {
    const w = src.width, h = src.height;
    const gray0 = window.DS.toGray(src.getContext('2d').getImageData(0, 0, w, h));
    const angle = projectionVarianceAngle(gray0, w, h).angle;
    let canvas = src;
    if (Math.abs(angle) >= 0.15) canvas = rotateCanvas(src, angle);
    const g = window.DS.toGray(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height));
    const confidence = window.DS.estimateGrid(g, canvas.width, canvas.height).confidence;
    return { canvas, angle, confidence };
  }

  window.DS = window.DS || {};
  Object.assign(window.DS, { autoDeskew, detectDotAngle, rotateCanvas, smartDeskew, projectionVarianceAngle });
})();
