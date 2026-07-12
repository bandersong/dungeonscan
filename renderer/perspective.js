/*
 * 4-corner perspective (keystone) correction for angled photos. A phone shot
 * of a page lying on a table is not just rotated, it's trapezoidally distorted
 * — near edge big, far edge small. Deskew (rectify.js) only removes rotation,
 * so it has to run AFTER the page is de-warped back to a rectangle, otherwise
 * the wall/grid detectors see non-parallel lines and misalign.
 *
 * This solves a real 8-DOF projective homography (not an affine approximation):
 * the 4 source corners → an axis-aligned dest rectangle, via an 8×8 Gaussian
 * elimination, then inverse-warps each dest pixel back into the source with
 * bilinear sampling. autoDetectPage() is a best-effort guess at the page quad
 * so the user doesn't have to drag all four corners by hand on a clean shot.
 *
 * Pure JS + canvas. No dependencies.
 */
(function () {
  'use strict';

  function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }

  // Solve a square linear system A·h = b by Gaussian elimination with partial
  // pivoting. Returns the solution vector, or null if A is (near) singular.
  // A is n×n (array of rows), b is length n.
  function solveLinear(A, b) {
    const n = b.length;
    // Augment A with b so we can pivot whole rows in one swap.
    const M = new Array(n);
    for (let i = 0; i < n; i++) M[i] = A[i].concat([b[i]]);
    for (let col = 0; col < n; col++) {
      // Partial pivot: bring the largest-magnitude entry in this column to the
      // diagonal to keep the elimination numerically stable.
      let piv = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      }
      if (Math.abs(M[piv][col]) < 1e-12) return null; // singular / degenerate corners
      if (piv !== col) { const tmp = M[piv]; M[piv] = M[col]; M[col] = tmp; }
      const diag = M[col][col];
      for (let r = col + 1; r < n; r++) {
        const f = M[r][col] / diag;
        if (f === 0) continue;
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    // Back-substitution.
    const x = new Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
      x[r] = s / M[r][r];
    }
    return x;
  }

  // Solve the homography H mapping destRect → srcQuad (both ordered TL,TR,BR,BL).
  // H has 8 unknowns (the 9th entry is fixed at 1 by scale invariance). For each
  // correspondence dest (x,y) → src (X,Y):
  //   X = (h0·x + h1·y + h2) / (h6·x + h7·y + 1)
  //   Y = (h3·x + h4·y + h5) / (h6·x + h7·y + 1)
  // clearing the denominator gives 2 linear equations per corner → 8×8 system.
  // Returns [h0..h7] or null if the quad is degenerate.
  function solveHomography(dest, src) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const x = dest[i].x, y = dest[i].y;
      const X = src[i].x, Y = src[i].y;
      A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
      A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
    }
    return solveLinear(A, b);
  }

  // De-warp srcCanvas so the given quad becomes an axis-aligned rectangle.
  // corners = [{x,y}×4] in SOURCE pixel coords, ordered TL, TR, BR, BL.
  // Returns a new canvas; dest size = average of the quad's opposing side lengths.
  function correct(srcCanvas, corners) {
    if (!corners || corners.length !== 4) throw new Error('perspective.correct needs 4 corners');
    const sw = srcCanvas.width, sh = srcCanvas.height;
    const sctx = srcCanvas.getContext('2d');
    const srcImg = sctx.getImageData(0, 0, sw, sh);
    const sd = srcImg.data;

    // Dest dimensions from the average of the two widths / two heights of the
    // quad, so a square page stays square regardless of keystone.
    const top = dist(corners[0], corners[1]);
    const right = dist(corners[1], corners[2]);
    const bottom = dist(corners[2], corners[3]);
    const left = dist(corners[3], corners[0]);
    const dw = Math.max(1, Math.round((top + bottom) / 2));
    const dh = Math.max(1, Math.round((left + right) / 2));

    const dest = [{ x: 0, y: 0 }, { x: dw, y: 0 }, { x: dw, y: dh }, { x: 0, y: dh }];
    const h = solveHomography(dest, corners);
    if (!h) {
      // Degenerate (collinear) corners — hand back an unwarped copy so the
      // pipeline still produces something the user can fix by hand.
      const fb = document.createElement('canvas'); fb.width = sw; fb.height = dh || sh;
      return fb;
    }
    const h0 = h[0], h1 = h[1], h2 = h[2], h3 = h[3], h4 = h[4], h5 = h[5], h6 = h[6], h7 = h[7];

    const out = sctx.createImageData(dw, dh);
    const od = out.data;
    const sw1 = sw - 1, sh1 = sh - 1;

    // Inverse warp: for each DEST pixel, map back into src and sample. The dest
    // rectangle's interior maps to the src quad's interior, so every dest pixel
    // resolves to a valid src coordinate; the out-of-bounds branch is just a
    // safety net for rounding at the very edge.
    for (let dy = 0; dy < dh; dy++) {
      const rowBase = dy * dw;
      for (let dx = 0; dx < dw; dx++) {
        const denom = h6 * dx + h7 * dy + 1;
        const o = (rowBase + dx) * 4;
        let sx, sy;
        if (Math.abs(denom) < 1e-12) {
          sx = -1; sy = -1;
        } else {
          sx = (h0 * dx + h1 * dy + h2) / denom;
          sy = (h3 * dx + h4 * dy + h5) / denom;
        }
        if (sx < 0 || sy < 0 || sx > sw1 || sy > sh1) {
          od[o] = 255; od[o + 1] = 255; od[o + 2] = 255; od[o + 3] = 255;
          continue;
        }
        // Bilinear sample (inlined — this is the hot loop).
        const x0 = sx | 0, y0 = sy | 0;
        const x1 = x0 < sw1 ? x0 + 1 : x0;
        const y1 = y0 < sh1 ? y0 + 1 : y0;
        const fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
        const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy, w11 = fx * fy;
        od[o] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
        od[o + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
        od[o + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
        od[o + 3] = sd[i00 + 3] * w00 + sd[i10 + 3] * w10 + sd[i01 + 3] * w01 + sd[i11 + 3] * w11;
      }
    }

    const dstc = document.createElement('canvas');
    dstc.width = dw; dstc.height = dh;
    dstc.getContext('2d').putImageData(out, 0, 0);
    return dstc;
  }

  // ---------- page detection helpers ----------

  function toGrayArr(img) {
    const d = img.data, n = img.width * img.height;
    const g = new Uint8ClampedArray(n);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    return g;
  }

  function otsu(hist, total) {
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, max = 0, thr = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (wB === 0) continue;
      const wF = total - wB; if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > max) { max = between; thr = t; }
    }
    return thr;
  }

  // Least-squares fit of x = a*y + b through a set of (x,y) points (used for
  // the near-vertical left/right page edges). Returns {a,b} or null if the
  // points don't span enough range to define a line.
  function fitVerticalEdge(pts) {
    let sx = 0, sy = 0, sxy = 0, syy = 0, n = pts.length;
    for (let i = 0; i < n; i++) { sx += pts[i].x; sy += pts[i].y; sxy += pts[i].x * pts[i].y; syy += pts[i].y * pts[i].y; }
    const denom = n * syy - sy * sy;
    if (denom < 1e-6) return null;
    const a = (n * sxy - sx * sy) / denom;
    const b = (sx - a * sy) / n;
    return { a, b };
  }
  // Least-squares fit of y = c*x + d (near-horizontal top/bottom edges).
  function fitHorizontalEdge(pts) {
    let sx = 0, sy = 0, sxy = 0, sxx = 0, n = pts.length;
    for (let i = 0; i < n; i++) { sx += pts[i].x; sy += pts[i].y; sxy += pts[i].x * pts[i].y; sxx += pts[i].x * pts[i].x; }
    const denom = n * sxx - sx * sx;
    if (denom < 1e-6) return null;
    const c = (n * sxy - sx * sy) / denom;
    const d = (sy - c * sx) / n;
    return { c, d };
  }
  // Intersection of x=a*y+b (vertical-ish) and y=c*x+d (horizontal-ish).
  function intersect(v, hz) {
    const denom = 1 - v.a * hz.c;
    if (Math.abs(denom) < 1e-6) return null; // edges parallel — shouldn't meet
    const x = (v.a * hz.d + v.b) / denom;
    const y = hz.c * x + hz.d;
    return { x, y };
  }

  // Best-effort estimate of the document's 4 corners (TL,TR,BR,BL) in SOURCE
  // pixel coords. Works on a downscaled grayscale copy: build a foreground mask
  // (bright paper OR high-contrast ink), then trace each of the four edges as a
  // least-squares line and intersect neighbours to get a real quad that follows
  // slanted page borders. Fallback = the four image corners.
  function autoDetectPage(srcCanvas) {
    const sw = srcCanvas.width, sh = srcCanvas.height;
    const full = [{ x: 0, y: 0 }, { x: sw, y: 0 }, { x: sw, y: sh }, { x: 0, y: sh }];
    const maxDim = 256;
    const scale = Math.min(1, maxDim / Math.max(sw, sh));
    const w = Math.max(8, Math.round(sw * scale)), h = Math.max(8, Math.round(sh * scale));

    const small = document.createElement('canvas'); small.width = w; small.height = h;
    const x = small.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
    x.drawImage(srcCanvas, 0, 0, w, h);
    const g = toGrayArr(x.getImageData(0, 0, w, h));

    // Histogram + Otsu threshold for the "bright paper" signal.
    const hist = new Uint32Array(256);
    for (let i = 0; i < g.length; i++) hist[g[i]]++;
    const thr = otsu(hist, g.length);

    // Foreground mask: bright (paper on a dark surface) OR strong local gradient
    // (ink/content). OR-ing both means this also latches onto a page whose tone
    // matches the background but which carries high-contrast drawing.
    const grad = new Uint8ClampedArray(g.length);
    let gmax = 0;
    for (let y = 0; y < h; y++) {
      for (let xi = 0; xi < w; xi++) {
        const i = y * w + xi;
        const gx = (xi + 1 < w ? Math.abs(g[i + 1] - g[i - 1]) : 0);
        const gy = (y + 1 < h ? Math.abs(g[i + w] - g[i - w]) : 0);
        grad[i] = gx + gy;
        if (grad[i] > gmax) gmax = grad[i];
      }
    }
    const gthr = Math.max(24, gmax * 0.25); // ignore faint noise; keep real edges
    const fg = new Uint8Array(g.length);
    let count = 0;
    for (let i = 0; i < g.length; i++) {
      const isFg = g[i] >= thr || grad[i] >= gthr;
      fg[i] = isFg ? 1 : 0;
      if (isFg) count++;
    }
    // If almost everything (or almost nothing) is foreground, the page fills the
    // frame (or isn't visible) — no border to trace, so hand back the full frame.
    if (count < 0.02 * g.length || count > 0.98 * g.length) return full;

    // Axis-aligned bounding box of the foreground, then trace each edge within
    // a band around it so a slanted border is followed rather than approximated.
    let x0 = w, x1 = 0, y0 = h, y1 = 0;
    for (let y = 0; y < h; y++) for (let xi = 0; xi < w; xi++) {
      if (!fg[y * w + xi]) continue;
      if (xi < x0) x0 = xi; if (xi > x1) x1 = xi;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 <= x0 || y1 <= y0) return full;
    const bw = x1 - x0, bh = y1 - y0;
    const bandX = Math.max(2, Math.round(bw * 0.12)); // search band width per side
    const bandY = Math.max(2, Math.round(bh * 0.12));

    // Left edge: for each row, the first foreground column inside [x0, x0+bandX].
    const left = [], right = [], top = [], bot = [];
    for (let y = y0; y <= y1; y++) {
      const base = y * w;
      for (let xi = x0; xi <= Math.min(w - 1, x0 + bandX); xi++) {
        if (fg[base + xi]) { left.push({ x: xi, y: y }); break; }
      }
      for (let xi = Math.min(w - 1, x1); xi >= Math.max(0, x1 - bandX); xi--) {
        if (fg[base + xi]) { right.push({ x: xi, y: y }); break; }
      }
    }
    for (let xi = x0; xi <= x1; xi++) {
      for (let y = y0; y <= Math.min(h - 1, y0 + bandY); y++) {
        if (fg[y * w + xi]) { top.push({ x: xi, y: y }); break; }
      }
      for (let y = Math.min(h - 1, y1); y >= Math.max(0, y1 - bandY); y--) {
        if (fg[y * w + xi]) { bot.push({ x: xi, y: y }); break; }
      }
    }

    const minPts = 8;
    // Fit each edge; fall back to the image frame if an edge can't be traced.
    const leftE = left.length >= minPts ? fitVerticalEdge(left) : { a: 0, b: 0 };
    const rightE = right.length >= minPts ? fitVerticalEdge(right) : { a: 0, b: w };
    const topE = top.length >= minPts ? fitHorizontalEdge(top) : { c: 0, d: 0 };
    const botE = bot.length >= minPts ? fitHorizontalEdge(bot) : { c: 0, d: h };

    const tl = intersect(leftE, topE);
    const tr = intersect(rightE, topE);
    const br = intersect(rightE, botE);
    const bl = intersect(leftE, botE);
    if (!tl || !tr || !br || !bl) return full;
    const quad = [tl, tr, br, bl];

    // Validate: corners inside the frame and a sensible ordered (convex) quad.
    const s = 1 / scale; // small→source pixel scale
    const out = quad.map(p => ({ x: clamp(p.x, 0, w) * s, y: clamp(p.y, 0, h) * s }));
    if (!isConvexQuad(out)) return full;
    return out;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // A valid page quad is convex and ordered consistently (signed area of each
  // successive edge triple has the same sign — no reflex angles / bowties).
  function isConvexQuad(q) {
    const area = Math.abs(signedArea(q));
    if (area < 16 * 16) return false; // too small to be a real page
    let pos = 0, neg = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (cross > 0) pos++; else if (cross < 0) neg++;
    }
    return pos === 0 || neg === 0;
  }
  function signedArea(q) {
    let s = 0;
    for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; s += (a.x * b.y - b.x * a.y); }
    return s / 2;
  }

  window.DS = window.DS || {};
  window.DS.perspective = { correct, autoDetectPage, solveHomography };
})();
