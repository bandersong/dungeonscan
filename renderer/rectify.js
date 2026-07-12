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
    return { angle: pk < 45 ? pk : pk - 90, dots: dots.length };
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

  // Straighten by choosing, among candidate rotations, the one the GRID detector is
  // most confident about. Candidates: no-op, the projection deskew, and ± the
  // dot-lattice angle. The grid detector is the judge, so a wrong dot/projection
  // guess is out-voted and a straight scan is never rotated away from true (0° is
  // always in the running). Fixes hand-drawn maps drawn at an angle on the page,
  // which projection-deskew alone gets wrong. Returns { canvas, angle, confidence }.
  function smartDeskew(src) {
    const w = src.width, h = src.height;
    const gray0 = window.DS.toGray(src.getContext('2d').getImageData(0, 0, w, h));
    const dl = detectDotAngle(gray0, w, h);
    const ad = autoDeskew(src).angle;
    const cands = [0];
    const add = (v) => { const r = Math.round(v * 10) / 10; if (Math.abs(r) <= 30 && !cands.some(c => Math.abs(c - r) < 0.5)) cands.push(r); };
    if (Math.abs(ad) > 0.2) add(ad);
    if (dl.angle && Math.abs(dl.angle) <= 25) { add(dl.angle); add(-dl.angle); }
    let best = { deg: 0, conf: -1, canvas: src };
    for (const deg of cands) {
      const rc = rotateCanvas(src, deg);
      const g = window.DS.toGray(rc.getContext('2d').getImageData(0, 0, rc.width, rc.height));
      const e = window.DS.estimateGrid(g, rc.width, rc.height);
      if (e.confidence > best.conf) best = { deg, conf: e.confidence, canvas: rc };
    }
    return { canvas: best.canvas, angle: best.deg, confidence: best.conf };
  }

  window.DS = window.DS || {};
  Object.assign(window.DS, { autoDeskew, detectDotAngle, rotateCanvas, smartDeskew });
})();
