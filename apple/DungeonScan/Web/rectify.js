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

  window.DS = window.DS || {};
  Object.assign(window.DS, { autoDeskew });
})();
