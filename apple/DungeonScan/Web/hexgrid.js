/*
 * Hex MODE — wilderness / overland hex-crawl maps. The rest of DungeonScan does
 * SQUARE dungeons; this adds pointy-top hexes on AXIAL coordinates (col=q, row=r).
 *
 * Two coordinate frames, kept deliberately separate:
 *   - SOURCE (the photo): grid.{size,ox,oy,cols,rows} describe detected hexes in
 *     image pixels. hexCenter / hexAt / hexPolygon work here, for the paint overlay.
 *   - OUTPUT (the clean render): renderHexMap lays hexes out fresh from (0,0) at
 *     circumradius `ppg`, so source ox/oy do not carry over — same split render.js
 *     uses (it takes C,R and redraws from scratch).
 *
 * This is paint-based: the user brushes a terrain onto each hex. There is no auto
 * terrain-read yet; estimateHexGrid just gives a starting overlay the user locks.
 *
 * Pointy-top axial geometry (Red Blob convention, canvas y-down):
 *   center(q,r) = ( ox + √3·size·(q + r/2),  oy + 1.5·size·r )
 *   width  = √3·size      (flat-to-flat across)
 *   height = 2·size       (point-to-point)
 *   corners at angles 60°·i − 30°, i=0..5
 */
(function () {
  'use strict';

  const SQ3 = Math.sqrt(3);

  // ---------------------------------------------------------------- geometry

  function hexCenter(col, row, grid) {
    const S = grid.size;
    return {
      x: grid.ox + SQ3 * S * (col + row / 2),
      y: grid.oy + 1.5 * S * row
    };
  }

  // 6 corners of a pointy-top hex, clockwise from the upper-right vertex.
  function hexCornersAt(cx, cy, size) {
    const pts = new Array(6);
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30);
      pts[i] = { x: cx + size * Math.cos(a), y: cy + size * Math.sin(a) };
    }
    return pts;
  }

  function hexPolygon(col, row, grid) {
    const c = hexCenter(col, row, grid);
    return hexCornersAt(c.x, c.y, grid.size);
  }

  // round fractional axial (qf,rf) to the nearest hex via cube coords
  function hexRound(qf, rf) {
    const sf = -qf - rf;
    let q = Math.round(qf), r = Math.round(rf), s = Math.round(sf);
    const dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s - sf);
    if (dq > dr && dq > ds) q = -r - s;
    else if (dr > ds) r = -q - s;
    return { col: q, row: r };
  }

  // pixel → axial hit test; null when outside the defined grid bounds
  function hexAt(px, py, grid) {
    const S = grid.size;
    if (!S) return null;
    const x = px - grid.ox, y = py - grid.oy;
    const qf = (SQ3 / 3 * x - y / 3) / S;
    const rf = (2 / 3 * y) / S;
    const { col, row } = hexRound(qf, rf);
    if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return null;
    return { col, row };
  }

  // ------------------------------------------------------ grid estimation
  // Reuses the projection + autocorrelation idea from grid.js. For pointy-top
  // hexes the column (x) ink profile is periodic at the hex WIDTH (√3·size)
  // because the left/right flat edges line up; the row (y) profile is periodic
  // at the row pitch (1.5·size). We read both pitches, reconcile to one `size`,
  // then phase each axis. Best-effort — the UI lets the user nudge it true.

  function projections(gray, W, H) {
    if (window.DS && window.DS.projections) return window.DS.projections(gray, W, H);
    const col = new Float64Array(W), row = new Float64Array(H);
    for (let y = 0; y < H; y++) {
      const base = y * W;
      for (let x = 0; x < W; x++) {
        const ink = 255 - gray[base + x];
        col[x] += ink; row[y] += ink;
      }
    }
    return { col, row };
  }

  function meanSub(a) {
    let m = 0; for (let i = 0; i < a.length; i++) m += a[i]; m /= a.length;
    const b = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) b[i] = a[i] - m;
    return b;
  }

  // best periodic lag in [lo,hi] by normalized autocorrelation, collapsing octaves
  function bestPitch(profile, lo, hi) {
    const a = meanSub(profile), n = a.length;
    const ac = (lag) => { let s = 0, c = 0; for (let i = 0; i + lag < n; i++) { s += a[i] * a[i + lag]; c++; } return c ? s / c : 0; };
    let bestLag = lo, bestVal = -Infinity;
    for (let lag = lo; lag <= hi; lag++) { const v = ac(lag); if (v > bestVal) { bestVal = v; bestLag = lag; } }
    let changed = true;
    while (changed) {
      changed = false;
      for (const d of [2, 3]) {
        const f = Math.round(bestLag / d);
        if (f >= lo && ac(f) >= 0.72 * ac(bestLag)) { bestLag = f; changed = true; break; }
      }
    }
    return { pitch: bestLag, strength: ac(bestLag) };
  }

  // phase (0..pitch-1) where the comb best aligns with the drawn lines
  function bestPhase(profile, pitch) {
    let bestOff = 0, bestSum = -Infinity;
    for (let off = 0; off < pitch; off++) {
      let s = 0;
      for (let x = off; x < profile.length; x += pitch) s += profile[x];
      if (s > bestSum) { bestSum = s; bestOff = off; }
    }
    return bestOff;
  }

  function estimateHexGrid(gray, W, H, opts) {
    opts = opts || {};
    const lo = opts.minSize || 6;
    const hi = opts.maxSize || Math.round(Math.min(W, H) / 3);
    const { col, row } = projections(gray, W, H);

    // Two reliable periods for a pointy-top grid:
    //   - ROW pitch   = 1.5·size              (vertical repeat is unambiguous)
    //   - COLUMN pitch = √3·size / 2          (flat edges from adjacent rows INTERLEAVE
    //                                          at half the hex width, so that is the
    //                                          fundamental the autocorrelation locks onto)
    // The column may instead report the full width √3·size if the rows happen to be in
    // phase, so we detect which fundamental landed and convert both to a size, anchored
    // on the (more reliable) row pitch.
    const pw = bestPitch(col, Math.round((SQ3 / 2) * lo), Math.round(SQ3 * hi));
    const pv = bestPitch(row, Math.round(1.5 * lo), Math.round(1.5 * hi));
    const sizeFromV = pv.pitch / 1.5;
    const sizeWFull = pw.pitch / SQ3;        // if pw landed on the full width
    const sizeWHalf = (2 * pw.pitch) / SQ3;  // if pw landed on the half width
    const sizeFromW = Math.abs(sizeWFull - sizeFromV) < Math.abs(sizeWHalf - sizeFromV) ? sizeWFull : sizeWHalf;
    let size;
    if (pw.strength > 0 && pv.strength > 0) size = (sizeFromV + sizeFromW) / 2;
    else size = pv.strength > 0 ? sizeFromV : sizeFromW;
    size = Math.max(lo, Math.round(size));

    const width = SQ3 * size, halfWidth = width / 2;
    // x: the edge comb repeats at half-width. The column profile alone can't tell an
    // edge-column from a center-column (edges recur every halfWidth), so ox is only a
    // phase anchor — the user slides the overlay to lock the true center.
    const ox = bestPhase(col, Math.max(1, Math.round(halfWidth))) + halfWidth;
    // y: row phase is a first-row-center proxy (best-effort — the user nudges)
    const oy = bestPhase(row, Math.max(1, Math.round(1.5 * size)));
    const cols = Math.max(1, Math.floor((W - ox) / width) + 1);
    const rows = Math.max(1, Math.floor((H - oy) / (1.5 * size)) + 1);
    return { size, ox, oy, cols, rows, width, confident: Math.min(pw.strength, pv.strength) > 0 };
  }

  // --------------------------------------------------------------- terrains

  const TERRAINS = [
    { id: 'plains',    name: 'Plains',    color: '#a3b673', accent: '#7d9248' },
    { id: 'forest',    name: 'Forest',    color: '#4f7a3a', accent: '#2f5526' },
    { id: 'hills',     name: 'Hills',     color: '#b6a673', accent: '#8a7a4a' },
    { id: 'mountains', name: 'Mountains', color: '#9a958f', accent: '#5d5852' },
    { id: 'water',     name: 'Water',     color: '#3f6ea8', accent: '#9fc0e4' },
    { id: 'swamp',     name: 'Swamp',     color: '#5f6f48', accent: '#3c4830' },
    { id: 'desert',    name: 'Desert',    color: '#dbc784', accent: '#b59f5e' },
    { id: 'road',      name: 'Road',      color: '#b08a68', accent: '#7a5a3e' }
  ];
  const TERRAIN_BY_ID = {};
  for (const t of TERRAINS) TERRAIN_BY_ID[t.id] = t;

  const HEX_STYLES = {
    parchment: { void: '#efe6cf', land: '#e7dcc0', grid: 'rgba(80,60,30,0.30)', label: '#3a2c14' },
    blueprint: { void: '#0d2f52', land: '#123a63', grid: 'rgba(150,190,225,0.40)', label: '#eaf3ff' },
    ink:       { void: '#ffffff', land: '#fbfbf6', grid: 'rgba(40,40,40,0.28)', label: '#161616' },
    satellite: { void: '#102b1a', land: '#3d5a36', grid: 'rgba(20,30,15,0.45)', label: '#f4f0d8' }
  };

  // deterministic jitter so a re-render is pixel-stable (no Math.random drift)
  function hash(c, r, i) {
    let h = Math.imul((c | 0), 374761393) + Math.imul((r | 0), 668265263) + Math.imul((i | 0), 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = Math.imul(h ^ (h >>> 16), 2246822519);
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
  }

  function tracePoly(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }

  // simple, cheap per-terrain texture, scaled to hex circumradius S
  function drawTexture(id, accent, ctx, cx, cy, S, col, row) {
    if (S < 9) return;
    const rnd = (i) => hash(col, row, i);
    ctx.save();
    ctx.fillStyle = accent; ctx.strokeStyle = accent;
    const line = (x0, y0, x1, y1) => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); };
    const dot = (x, y, r) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); };
    switch (id) {
      case 'plains': // grass tufts
        ctx.lineWidth = Math.max(1, S * 0.06);
        for (let i = 0; i < 6; i++) { const a = rnd(i) * 6.283, r = S * 0.55 * rnd(i + 10), x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; line(x, y, x, y - S * 0.16); }
        break;
      case 'forest': // little conifers
        for (let i = 0; i < 5; i++) { const a = rnd(i) * 6.283, r = S * 0.5 * rnd(i + 10), x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r, h = S * 0.34;
          ctx.beginPath(); ctx.moveTo(x, y - h * 0.6); ctx.lineTo(x - h * 0.18, y + h * 0.2); ctx.lineTo(x + h * 0.18, y + h * 0.2); ctx.closePath(); ctx.fill(); }
        break;
      case 'hills': // arc bumps
        ctx.lineWidth = Math.max(1.2, S * 0.09);
        for (let i = 0; i < 3; i++) { const a = rnd(i) * 6.283, r = S * 0.45 * rnd(i + 10), x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
          ctx.beginPath(); ctx.arc(x, y, S * 0.22, 3.613, 5.812); ctx.stroke(); }
        break;
      case 'mountains': // twin peaks
        for (let i = 0; i < 2; i++) { const x = cx + (i ? S * 0.22 : -S * 0.22), y = cy + S * 0.05, h = S * 0.5;
          ctx.beginPath(); ctx.moveTo(x, y + h * 0.3); ctx.lineTo(x, y - h * 0.5); ctx.lineTo(x + h * 0.3, y + h * 0.3); ctx.closePath(); ctx.fill(); }
        break;
      case 'water': // wavy lines
        ctx.lineWidth = Math.max(1, S * 0.05);
        for (let j = -1; j <= 1; j++) { const y0 = cy + j * S * 0.28; ctx.beginPath();
          for (let k = 0; k <= 8; k++) { const xx = -S * 0.5 + (S * 0.125) * k, yy = y0 + Math.sin(xx / S * 4) * S * 0.05; if (k === 0) ctx.moveTo(cx + xx, yy); else ctx.lineTo(cx + xx, yy); } ctx.stroke(); }
        break;
      case 'swamp': // reeds + dots
        ctx.lineWidth = Math.max(1, S * 0.05);
        for (let i = 0; i < 6; i++) { const a = rnd(i) * 6.283, r = S * 0.5 * rnd(i + 10), x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; line(x, y, x, y - S * 0.18); }
        for (let i = 0; i < 4; i++) { const a = rnd(i + 20) * 6.283, r = S * 0.4 * rnd(i + 30), x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; dot(x, y, Math.max(0.8, S * 0.04)); }
        break;
      case 'desert': // stipple
        for (let i = 0; i < 10; i++) { const a = rnd(i) * 6.283, r = S * 0.55 * rnd(i + 10), x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; dot(x, y, Math.max(0.8, S * 0.04)); }
        break;
      case 'road': // dashed track
        ctx.lineWidth = Math.max(2, S * 0.14); ctx.setLineDash([S * 0.22, S * 0.16]);
        line(cx - S * 0.55, cy, cx + S * 0.55, cy); ctx.setLineDash([]);
        break;
    }
    ctx.restore();
  }

  // output-space layout for an axial cols×rows region at circumradius S
  function outLayout(cols, rows, S) {
    const maxXc = SQ3 * S * ((cols - 1) + (rows - 1) / 2);
    const maxYc = 1.5 * S * (rows - 1);
    const padX = SQ3 * S / 2, padY = S;
    const W = Math.max(1, Math.ceil(maxXc + padX * 2));
    const H = Math.max(1, Math.ceil(maxYc + padY * 2));
    const ox = padX, oy = padY;
    const center = (col, row) => ({ x: ox + SQ3 * S * (col + row / 2), y: oy + 1.5 * S * row });
    return { W, H, ox, oy, center };
  }

  function renderHexMap(opts) {
    const grid = opts.grid || {};
    const cols = Math.max(1, grid.cols || 10);
    const rows = Math.max(1, grid.rows || 8);
    const S = opts.ppg || 48;
    const st = HEX_STYLES[opts.style] || HEX_STYLES.parchment;
    const terrain = opts.terrain instanceof Map ? opts.terrain : new Map(opts.terrain || []);
    const lay = outLayout(cols, rows, S);

    const cv = document.createElement('canvas'); cv.width = lay.W; cv.height = lay.H;
    const ctx = cv.getContext('2d');

    // void
    ctx.fillStyle = st.void; ctx.fillRect(0, 0, lay.W, lay.H);

    const hexAtOut = (col, row) => hexCornersAt(lay.center(col, row).x, lay.center(col, row).y, S);

    // base land fill for every hex (unpainted reads as open land)
    ctx.fillStyle = st.land;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { tracePoly(ctx, hexAtOut(c, r)); ctx.fill(); }

    // painted terrain hexes
    for (const [key, id] of terrain.entries()) {
      const t = TERRAIN_BY_ID[id] || TERRAIN_BY_ID.plains;
      const parts = String(key).split(','); const c = +parts[0], r = +parts[1];
      if (!Number.isFinite(c) || !Number.isFinite(r)) continue;
      const ctr = lay.center(c, r);
      tracePoly(ctx, hexCornersAt(ctr.x, ctr.y, S));
      ctx.fillStyle = t.color; ctx.fill();
      drawTexture(t.id, t.accent, ctx, ctr.x, ctr.y, S, c, r);
    }

    // crisp hex grid on top
    ctx.strokeStyle = st.grid; ctx.lineWidth = Math.max(1, S / 40); ctx.lineJoin = 'round';
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { tracePoly(ctx, hexAtOut(c, r)); ctx.stroke(); }

    // features (labels / pins) above everything
    for (const f of opts.features || []) {
      const ctr = lay.center(f.col, f.row);
      if (f.kind === 'label') {
        ctx.fillStyle = st.label; ctx.font = `bold ${Math.round(S * 0.42)}px Georgia`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(f.text), ctr.x, ctr.y);
      } else if (f.kind === 'pin') {
        ctx.fillStyle = st.label; ctx.strokeStyle = st.label; ctx.lineWidth = Math.max(1, S * 0.05);
        ctx.beginPath(); ctx.arc(ctr.x, ctr.y, S * 0.12, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
    return cv;
  }

  // ------------------------------------------------------------- vtt export
  // Universal-VTT-ish for a hex map. The dd2vtt spec is square-oriented, so this
  // emits the usual envelope (resolution, image) plus an explicit hex grid hint.
  // Foundry scenes can be hex; an importer reads `grid` to place cells. Overland
  // maps have no walls — line_of_sight / portals are left empty by design.

  function hexToVTT(opts) {
    const grid = opts.grid || {};
    const cols = Math.max(1, grid.cols || 1);
    const rows = Math.max(1, grid.rows || 1);
    const S = opts.ppg || 48;
    const width = SQ3 * S, height = 2 * S;
    return {
      format: 0.3,
      resolution: {
        map_origin: { x: 0, y: 0 },
        map_size: { x: cols, y: rows },
        pixels_per_grid: Math.round(width)
      },
      grid: { type: 'hex', orientation: 'pointy-top', layout: 'axial', size: S, width, height },
      line_of_sight: [],
      objects_line_of_sight: [],
      portals: [],
      lights: [],
      environment: { baked_lighting: false, ambient_light: 'ffffffff' },
      image: opts.imageBase64 || ''
    };
  }

  // ------------------------------------------------------------- namespace
  window.DS = window.DS || {};
  window.DS.hex = {
    SQ3,
    estimateHexGrid,
    hexCenter,
    hexAt,
    hexCornersAt,
    hexPolygon,
    hexRound,
    renderHexMap,
    hexToVTT,
    outLayout,
    TERRAINS,
    TERRAIN_BY_ID,
    HEX_STYLES
  };
})();
