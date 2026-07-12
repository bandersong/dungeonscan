/*
 * DungeonScan core digitizer.
 * Given a rectified grayscale image and a grid (cell size + offset), read which
 * grid EDGES are walls (he draws walls on cell boundaries) and which CELLS are
 * floor (enclosed regions). Pure JS, no deps — runs anywhere, sandbox-safe.
 *
 * Coordinate model:
 *   grid pitch s px, origin (ox,oy). Cell (col,row) covers
 *   x in [ox+col*s, ox+(col+1)*s], y in [oy+row*s, oy+(row+1)*s].
 *   Columns 0..C-1, rows 0..R-1.
 *   Vertical wall edges:  vEdge[row][col] on the line x = ox+col*s, col 0..C, row 0..R-1.
 *   Horizontal wall edges: hEdge[row][col] on the line y = oy+row*s, row 0..R, col 0..C-1.
 */
(function () {
  'use strict';

  // ---- grayscale + integral-image adaptive threshold ----

  // Returns Uint8 grayscale (0=black ink .. 255=paper) from an ImageData.
  function toGray(img) {
    const d = img.data, n = img.width * img.height;
    const g = new Uint8ClampedArray(n);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      g[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    }
    return g;
  }

  // "ink intensity" = 255 - gray, so darker strokes score higher.
  function inkField(gray) {
    const f = new Uint8ClampedArray(gray.length);
    for (let i = 0; i < gray.length; i++) f[i] = 255 - gray[i];
    return f;
  }

  // Otsu threshold over an array of scores (0..255) -> cutoff.
  function otsu(scores) {
    const hist = new Float64Array(256);
    for (let i = 0; i < scores.length; i++) hist[Math.max(0, Math.min(255, scores[i] | 0))]++;
    const total = scores.length;
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, maxVar = -1, thr = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (wB === 0) continue;
      const wF = total - wB; if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > maxVar) { maxVar = between; thr = t; }
    }
    return thr;
  }

  // ---- wall detection: measure ink on every grid edge ----

  /*
   * For each grid edge, average the ink intensity in a thin band centered on the
   * edge line (the band tolerates a hand-drawn wall that isn't dead-on the line).
   * Then Otsu-split the edge scores into wall / not-wall, with an absolute floor
   * so a blank drawing yields no walls.
   */
  function detectWalls(gray, W, H, grid, opts) {
    opts = opts || {};
    const ink = inkField(gray);
    const { s, ox, oy, C, R } = grid;
    const band = Math.max(1, Math.round(s * (opts.bandFrac || 0.16)));
    // shrink each edge slightly at its ends so we sample the wall, not the corner blob
    const pad = Math.max(1, Math.round(s * 0.14));

    const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 0 : ink[y * W + x];

    // sample mean ink along a segment with a perpendicular band
    function scoreSeg(x0, y0, x1, y1) {
      const vertical = (x0 === x1);
      let sum = 0, cnt = 0;
      if (vertical) {
        const xc = x0;
        for (let y = y0 + pad; y <= y1 - pad; y++) {
          let best = 0;
          for (let dx = -band; dx <= band; dx++) best = Math.max(best, at(xc + dx, y));
          sum += best; cnt++;
        }
      } else {
        const yc = y0;
        for (let x = x0 + pad; x <= x1 - pad; x++) {
          let best = 0;
          for (let dy = -band; dy <= band; dy++) best = Math.max(best, at(x, yc + dy));
          sum += best; cnt++;
        }
      }
      return cnt ? sum / cnt : 0;
    }

    // vEdge[row][col]: col 0..C, row 0..R-1
    const vScore = [], hScore = [];
    const vList = [], hList = [];
    for (let row = 0; row < R; row++) {
      vScore[row] = new Float32Array(C + 1);
      for (let col = 0; col <= C; col++) {
        const x = Math.round(ox + col * s);
        const y0 = Math.round(oy + row * s), y1 = Math.round(oy + (row + 1) * s);
        const sc = scoreSeg(x, y0, x, y1);
        vScore[row][col] = sc; vList.push(sc);
      }
    }
    for (let row = 0; row <= R; row++) {
      hScore[row] = new Float32Array(C);
      for (let col = 0; col < C; col++) {
        const y = Math.round(oy + row * s);
        const x0 = Math.round(ox + col * s), x1 = Math.round(ox + (col + 1) * s);
        const sc = scoreSeg(x0, y, x1, y);
        hScore[row][col] = sc; hList.push(sc);
      }
    }

    // threshold: Otsu over the combined edge scores, but never below an absolute
    // minimum (so a nearly-blank sheet doesn't hallucinate walls).
    const all = vList.concat(hList).map((v) => v | 0);
    let thr = otsu(all);
    thr = Math.max(thr, opts.minInk || 40);
    // if the drawing is high-contrast, bias a touch toward the wall side
    thr = Math.round(thr * (opts.thrScale || 0.92));

    const vEdge = [], hEdge = [];
    for (let row = 0; row < R; row++) {
      vEdge[row] = new Uint8Array(C + 1);
      for (let col = 0; col <= C; col++) vEdge[row][col] = vScore[row][col] >= thr ? 1 : 0;
    }
    for (let row = 0; row <= R; row++) {
      hEdge[row] = new Uint8Array(C);
      for (let col = 0; col < C; col++) hEdge[row][col] = hScore[row][col] >= thr ? 1 : 0;
    }
    return { vEdge, hEdge, vScore, hScore, threshold: thr, C, R };
  }

  // ---- floor: cells enclosed by walls (flood from the exterior) ----

  /*
   * Flood-fill the cell lattice starting from a virtual exterior around the map,
   * only crossing edges that are NOT walls. Cells the exterior can reach are
   * "outside" (blank paper); cells it cannot reach are enclosed => floor.
   */
  function detectFloor(walls) {
    const { vEdge, hEdge, C, R } = walls;
    const outside = new Uint8Array(C * R); // 1 = reachable from exterior
    const stack = [];
    // seed: any border cell whose border-facing edge is open is reachable;
    // simplest robust seed: push every border cell, then flood through open edges.
    const push = (c, r) => { if (c >= 0 && r >= 0 && c < C && r < R && !outside[r * C + c]) { outside[r * C + c] = 1; stack.push(r * C + c); } };
    for (let c = 0; c < C; c++) { push(c, 0); push(c, R - 1); }
    for (let r = 0; r < R; r++) { push(0, r); push(C - 1, r); }
    while (stack.length) {
      const idx = stack.pop(), r = (idx / C) | 0, c = idx - r * C;
      // left neighbor (c-1) across vEdge[r][c]
      if (c > 0 && !vEdge[r][c]) push(c - 1, r);
      // right neighbor (c+1) across vEdge[r][c+1]
      if (c < C - 1 && !vEdge[r][c + 1]) push(c + 1, r);
      // up neighbor (r-1) across hEdge[r][c]
      if (r > 0 && !hEdge[r][c]) push(c, r - 1);
      // down neighbor (r+1) across hEdge[r+1][c]
      if (r < R - 1 && !hEdge[r + 1][c]) push(c, r + 1);
    }
    const floor = new Uint8Array(C * R);
    for (let i = 0; i < floor.length; i++) floor[i] = outside[i] ? 0 : 1;
    return floor; // floor[r*C+c]
  }

  // ---- merge unit wall edges into minimal polylines (grid units) ----

  function mergeWalls(walls) {
    const { vEdge, hEdge, C, R } = walls;
    const segs = [];
    // horizontal runs: for each edge-row, merge consecutive columns
    for (let row = 0; row <= R; row++) {
      let c = 0;
      while (c < C) {
        if (hEdge[row][c]) {
          let c2 = c; while (c2 < C && hEdge[row][c2]) c2++;
          segs.push([{ x: c, y: row }, { x: c2, y: row }]);
          c = c2;
        } else c++;
      }
    }
    // vertical runs
    for (let col = 0; col <= C; col++) {
      let r = 0;
      while (r < R) {
        if (vEdge[r][col]) {
          let r2 = r; while (r2 < R && vEdge[r2][col]) r2++;
          segs.push([{ x: col, y: r }, { x: col, y: r2 }]);
          r = r2;
        } else r++;
      }
    }
    return segs; // array of [{x,y},{x,y}] in GRID units
  }

  // ---- geometric doorway guess: a 1-cell gap in a wall line between two floor
  //      cells, flanked by collinear walls. The classifier/user refine these. ----
  function detectDoorways(walls, floor) {
    const { vEdge, hEdge, C, R } = walls;
    const fl = (c, r) => (c < 0 || r < 0 || c >= C || r >= R) ? 0 : floor[r * C + c];
    const doors = [];
    for (let r = 0; r < R; r++) for (let c = 1; c < C; c++) {
      if (!vEdge[r][c] && fl(c - 1, r) && fl(c, r)) {
        const above = r > 0 ? vEdge[r - 1][c] : 0, below = r < R - 1 ? vEdge[r + 1][c] : 0;
        if (above && below) doors.push({ kind: 'v', col: c, row: r });
      }
    }
    for (let r = 1; r < R; r++) for (let c = 0; c < C; c++) {
      if (!hEdge[r][c] && fl(c, r - 1) && fl(c, r)) {
        const left = c > 0 ? hEdge[r][c - 1] : 0, right = c < C - 1 ? hEdge[r][c + 1] : 0;
        if (left && right) doors.push({ kind: 'h', col: c, row: r });
      }
    }
    return doors;
  }

  // ---- accuracy vs a ground-truth (for the test harness) ----
  function edgeAccuracy(walls, truth) {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    const cmp = (a, b, rows, colsFn) => {
      for (let r = 0; r < rows; r++) for (let c = 0; c < colsFn(r); c++) {
        const p = a[r][c], t = b[r][c];
        if (p && t) tp++; else if (p && !t) fp++; else if (!p && t) fn++; else tn++;
      }
    };
    cmp(walls.vEdge, truth.vEdge, walls.R, () => walls.C + 1);
    cmp(walls.hEdge, truth.hEdge, walls.R + 1, () => walls.C);
    const prec = tp / (tp + fp || 1), rec = tp / (tp + fn || 1);
    return { tp, fp, fn, tn, precision: prec, recall: rec, f1: 2 * prec * rec / (prec + rec || 1) };
  }

  window.DS = window.DS || {};
  Object.assign(window.DS, {
    toGray, inkField, otsu, detectWalls, detectFloor, mergeWalls, detectDoorways, edgeAccuracy
  });
})();
