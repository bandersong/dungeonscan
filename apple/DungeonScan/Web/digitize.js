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
   *
   * A second, independent CONTINUITY veto handles what mean-ink alone cannot:
   * on real photos a printed dot, page-border shading, or vignette can push an
   * edge's mean over the threshold without there being a drawn line. A real wall
   * is locally-dark along MOST of its edge; a dot covers a few px and smooth
   * shading is never locally dark (integral-image local paper estimate). Edges
   * whose ink coverage is under covFloor are vetoed. Solid drawn lines pass the
   * veto trivially, so the proven synthetic behaviour is unchanged.
   */
  function detectWalls(gray, W, H, grid, opts) {
    opts = opts || {};
    const ink = inkField(gray);
    const { s, ox, oy, C, R } = grid;
    // ±0.22s band: hand-drawn lines wobble well off the ideal lattice line; at
    // real cell pitches (≥20px) the band still clears the neighbouring edge.
    const band = Math.max(1, Math.round(s * (opts.bandFrac || 0.22)));
    // shrink each edge slightly at its ends so we sample the wall, not the corner blob
    const pad = Math.max(1, Math.round(s * 0.14));

    const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 0 : ink[y * W + x];

    // --- continuity veto machinery (local ink via integral image) ---
    const delta = Math.max(10, Math.round((opts.minInk != null ? opts.minInk : 40) * 0.5));
    const win = Math.max(8, Math.round(s));
    const I = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let rowSum = 0;
      const src = y * W, dst = (y + 1) * (W + 1) + 1, prev = y * (W + 1) + 1;
      for (let x = 0; x < W; x++) {
        rowSum += gray[src + x];
        I[dst + x] = I[prev + x] + rowSum;
      }
    }
    function localMean(x, y) {
      const x0 = Math.max(0, x - win), x1 = Math.min(W - 1, x + win);
      const y0 = Math.max(0, y - win), y1 = Math.min(H - 1, y + win);
      const a = I[y0 * (W + 1) + x0], b = I[y0 * (W + 1) + x1 + 1];
      const c = I[(y1 + 1) * (W + 1) + x0], d = I[(y1 + 1) * (W + 1) + x1 + 1];
      return (d - b - c + a) / ((x1 - x0 + 1) * (y1 - y0 + 1));
    }
    const isInk = (x, y) => (x >= 0 && y >= 0 && x < W && y < H) && gray[y * W + x] < localMean(x, y) - delta;

    // mean band-max ink + fraction of steps whose band holds locally-dark ink
    function scoreSeg(x0, y0, x1, y1) {
      const vertical = (x0 === x1);
      let sum = 0, cnt = 0, hit = 0;
      if (vertical) {
        const xc = x0;
        for (let y = y0 + pad; y <= y1 - pad; y++) {
          let best = 0, dark = false;
          for (let dx = -band; dx <= band; dx++) {
            const v = at(xc + dx, y);
            if (v > best) best = v;
            if (!dark && isInk(xc + dx, y)) dark = true;
          }
          sum += best; cnt++; if (dark) hit++;
        }
      } else {
        const yc = y0;
        for (let x = x0 + pad; x <= x1 - pad; x++) {
          let best = 0, dark = false;
          for (let dy = -band; dy <= band; dy++) {
            const v = at(x, yc + dy);
            if (v > best) best = v;
            if (!dark && isInk(x, yc + dy)) dark = true;
          }
          sum += best; cnt++; if (dark) hit++;
        }
      }
      return { mean: cnt ? sum / cnt : 0, cov: cnt ? hit / cnt : 0 };
    }

    // vEdge[row][col]: col 0..C, row 0..R-1
    const vScore = [], hScore = [], vCov = [], hCov = [];
    const vList = [], hList = [];
    for (let row = 0; row < R; row++) {
      vScore[row] = new Float32Array(C + 1); vCov[row] = new Float32Array(C + 1);
      for (let col = 0; col <= C; col++) {
        const x = Math.round(ox + col * s);
        const y0 = Math.round(oy + row * s), y1 = Math.round(oy + (row + 1) * s);
        const sc = scoreSeg(x, y0, x, y1);
        vScore[row][col] = sc.mean; vCov[row][col] = sc.cov; vList.push(sc.mean);
      }
    }
    for (let row = 0; row <= R; row++) {
      hScore[row] = new Float32Array(C); hCov[row] = new Float32Array(C);
      for (let col = 0; col < C; col++) {
        const y = Math.round(oy + row * s);
        const x0 = Math.round(ox + col * s), x1 = Math.round(ox + (col + 1) * s);
        const sc = scoreSeg(x0, y, x1, y);
        hScore[row][col] = sc.mean; hCov[row][col] = sc.cov; hList.push(sc.mean);
      }
    }

    // threshold: Otsu over the combined edge scores, but never below an absolute
    // minimum (so a nearly-blank sheet doesn't hallucinate walls).
    const all = vList.concat(hList).map((v) => v | 0);
    let thr = otsu(all);
    thr = Math.max(thr, opts.minInk || 40);
    // if the drawing is high-contrast, bias a touch toward the wall side
    thr = Math.round(thr * (opts.thrScale || 0.92));

    // continuity floor: dots/specks reach ≤~0.15 coverage, drawn lines ≥~0.6
    const covFloor = opts.covFloor != null ? opts.covFloor : 0.35;

    const vEdge = [], hEdge = [];
    for (let row = 0; row < R; row++) {
      vEdge[row] = new Uint8Array(C + 1);
      for (let col = 0; col <= C; col++) vEdge[row][col] = (vScore[row][col] >= thr && vCov[row][col] >= covFloor) ? 1 : 0;
    }
    for (let row = 0; row <= R; row++) {
      hEdge[row] = new Uint8Array(C);
      for (let col = 0; col < C; col++) hEdge[row][col] = (hScore[row][col] >= thr && hCov[row][col] >= covFloor) ? 1 : 0;
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
    const { C, R } = walls;
    // Close doorway gaps before flooding: a hand-drawn room has 1-edge openings
    // (doors!) that would let the exterior flood straight in and erase the room.
    // An open edge whose two COLINEAR neighbours are both walls is such a gap —
    // treat it as solid for enclosure only (detectDoorways still sees the
    // original open edge and calls it a door).
    const vEdge = walls.vEdge.map((row) => Uint8Array.from(row));
    const hEdge = walls.hEdge.map((row) => Uint8Array.from(row));
    for (let r = 0; r < R; r++) {
      for (let c = 0; c <= C; c++) {
        if (vEdge[r][c]) continue;
        const up = r > 0 ? walls.vEdge[r - 1][c] : 0;
        const dn = r < R - 1 ? walls.vEdge[r + 1][c] : 0;
        if (up && dn) vEdge[r][c] = 1;
      }
    }
    for (let r = 0; r <= R; r++) {
      for (let c = 0; c < C; c++) {
        if (hEdge[r][c]) continue;
        const lf = c > 0 ? walls.hEdge[r][c - 1] : 0;
        const rt = c < C - 1 ? walls.hEdge[r][c + 1] : 0;
        if (lf && rt) hEdge[r][c] = 1;
      }
    }
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

  // ---- "grid drawn" style: floor from CELL ink, walls from floor boundary ----
  // When the mapper draws every grid square (common on graph / dot paper), every
  // edge is inked, so edge-based wall detection paints the whole grid as walls.
  // Instead: a CELL that holds drawn content (grid lines / shading) is room floor;
  // blank paper is void. Walls become the floor/void boundary — the room outline.

  // Mean + std-dev of ink (0..255) inside each cell, inset to skip the
  // grid-line edges. sd separates drawn texture (high) from smooth shading
  // and vignette (near-zero) — mean alone cannot (measured on bro-03:
  // phantom-cell mean ≈ drawn-cell mean, but sd 2.6 vs 57.8 median).
  function cellInk(gray, W, H, grid) {
    const { s, ox, oy, C, R } = grid;
    const inset = Math.max(2, Math.round(s * 0.24));
    const cm = new Float32Array(C * R);
    const sd = new Float32Array(C * R);
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      const x0 = ox + c * s + inset, x1 = ox + (c + 1) * s - inset;
      const y0 = oy + r * s + inset, y1 = oy + (r + 1) * s - inset;
      let sum = 0, sum2 = 0, n = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const v = 255 - gray[y * W + x]; sum += v; sum2 += v * v; n++;
      }
      const m = n ? sum / n : 0;
      cm[r * C + c] = m;
      sd[r * C + c] = n ? Math.sqrt(Math.max(0, sum2 / n - m * m)) : 0;
    }
    return { cm, sd };
  }

  // Fraction (0..1) of INTERIOR grid edges carrying ink — high ⇒ the grid was
  // drawn in. Reuses detectWalls' per-edge scores, so it needs no extra scan.
  function gridDrawnScore(walls) {
    const { vEdge, hEdge, C, R } = walls;
    if (!vEdge || !hEdge) return 0;
    // Fraction of INTERIOR edges the edge detector called walls. A normal dungeon
    // (open rooms) leaves most interior edges open — low. When every square is
    // inked, edge detection marks nearly all of them — high. That degenerate case
    // is what "grid drawn" means, so cell-ink floor should take over.
    let w = 0, total = 0;
    for (let r = 0; r < R; r++) for (let c = 1; c < C; c++) { total++; if (vEdge[r][c]) w++; }
    for (let r = 1; r < R; r++) for (let c = 0; c < C; c++) { total++; if (hEdge[r][c]) w++; }
    return total ? w / total : 0;
  }

  // Floor = cells whose ink beats an Otsu split of the cell-ink histogram, then a
  // light cleanup (fill lone holes / drop lone specks). Returns {floor, walls}
  // with walls in the same shape as detectWalls so the app can use it in place.
  function detectFloorByInk(gray, W, H, grid, opts) {
    opts = opts || {};
    const { C, R } = grid;
    const { cm, sd } = cellInk(gray, W, H, grid);
    const hist = new Array(256).fill(0);
    for (let i = 0; i < cm.length; i++) hist[Math.min(255, Math.max(0, cm[i] | 0))]++;
    const tot = cm.length; let sumAll = 0; for (let i = 0; i < 256; i++) sumAll += i * hist[i];
    let wB = 0, sumB = 0, best = 0, thr = 20;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue; const wF = tot - wB; if (!wF) break; sumB += i * hist[i];
      const mB = sumB / wB, mF = (sumAll - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = i; }
    }
    thr = Math.max(thr * (opts.floorScale || 0.8), opts.floorMin || 12);
    // Smooth-shading veto: page-edge vignette lifts a blank cell's MEAN ink past
    // Otsu, but blank paper is flat (sd ~2-3) while drawn floor is textured
    // (sd 26+ at the 10th pct on bro-03). Without this, empty dot-paper corners
    // digitize as phantom rooms.
    const sdMin = opts.floorSdMin != null ? opts.floorSdMin : 10;
    let floor = new Uint8Array(C * R);
    for (let i = 0; i < C * R; i++) floor[i] = (cm[i] > thr && sd[i] > sdMin) ? 1 : 0;
    // one cleanup pass: fill a void cell with >=3 floor neighbours; drop a lone floor speck
    const nb = (f, c, r) => (c < 0 || r < 0 || c >= C || r >= R) ? 0 : f[r * C + c];
    const f2 = floor.slice();
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      const n = nb(floor, c - 1, r) + nb(floor, c + 1, r) + nb(floor, c, r - 1) + nb(floor, c, r + 1);
      if (!floor[r * C + c] && n >= 3) f2[r * C + c] = 1;
      else if (floor[r * C + c] && n === 0) f2[r * C + c] = 0;
    }
    floor = f2;
    const vEdge = [], hEdge = [];
    for (let r = 0; r < R; r++) { vEdge[r] = new Uint8Array(C + 1); for (let c = 0; c <= C; c++) { const l = c > 0 ? floor[r * C + c - 1] : 0, rr = c < C ? floor[r * C + c] : 0; vEdge[r][c] = (l !== rr) ? 1 : 0; } }
    for (let r = 0; r <= R; r++) { hEdge[r] = new Uint8Array(C); for (let c = 0; c < C; c++) { const u = r > 0 ? floor[(r - 1) * C + c] : 0, d = r < R ? floor[r * C + c] : 0; hEdge[r][c] = (u !== d) ? 1 : 0; } }
    return { floor, walls: { vEdge, hEdge, C, R } };
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

  // ---- room numbering: label each enclosed floor region 1,2,… in reading order
  //
  // Flood-fill the floor lattice the same way detectFloor seeds the exterior, but
  // here every disconnected floor region (cells joined through non-wall edges) is a
  // "room". Regions smaller than minSize (default 2) are ignored — a stray floor
  // speck isn't a room. Each surviving region is labelled at its cell centroid,
  // and regions are numbered top-to-bottom, left-to-right (reading order) by
  // centroid, so the labels read naturally down the map.
  function numberRooms(walls, floor, C, R, opts) {
    opts = opts || {};
    const minSize = opts.minSize != null ? opts.minSize : 2;
    const vEdge = walls.vEdge, hEdge = walls.hEdge;
    const seen = new Uint8Array(C * R);
    const rooms = [];
    for (let seed = 0; seed < C * R; seed++) {
      if (seen[seed] || !floor[seed]) continue;
      // collect the connected region around this seed (through open edges only)
      const region = [];
      const stack = [seed]; seen[seed] = 1;
      while (stack.length) {
        const idx = stack.pop(), r = (idx / C) | 0, c = idx - r * C;
        region.push(idx);
        if (c > 0 && !vEdge[r][c] && floor[idx - 1] && !seen[idx - 1]) { seen[idx - 1] = 1; stack.push(idx - 1); }
        if (c < C - 1 && !vEdge[r][c + 1] && floor[idx + 1] && !seen[idx + 1]) { seen[idx + 1] = 1; stack.push(idx + 1); }
        if (r > 0 && !hEdge[r][c] && floor[idx - C] && !seen[idx - C]) { seen[idx - C] = 1; stack.push(idx - C); }
        if (r < R - 1 && !hEdge[r + 1][c] && floor[idx + C] && !seen[idx + C]) { seen[idx + C] = 1; stack.push(idx + C); }
      }
      if (region.length < minSize) continue;
      let sx = 0, sy = 0;
      for (const idx of region) { const r = (idx / C) | 0, c = idx - r * C; sx += c; sy += r; }
      rooms.push({ col: Math.round(sx / region.length), row: Math.round(sy / region.length) });
    }
    // reading order: sort by centroid row then column
    rooms.sort((a, b) => (a.row - b.row) || (a.col - b.col));
    return rooms.map((p, i) => ({ kind: 'number', label: String(i + 1), col: p.col, row: p.row }));
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
    toGray, inkField, otsu, detectWalls, detectFloor, mergeWalls, detectDoorways, edgeAccuracy, numberRooms,
    cellInk, gridDrawnScore, detectFloorByInk
  });
})();
