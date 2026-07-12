/*
 * Synthetic hand-drawn grid-dungeon generator, with ground truth.
 * Used to PROVE the digitizer: we know exactly which edges are walls, so we can
 * measure precision/recall of detection instead of eyeballing it. Mimics the real
 * input — faint grid, bold wobbly room walls, a few glyphs, paper noise.
 */
(function () {
  'use strict';

  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  // carve rooms + 1-cell corridors -> floor[r*C+c]
  function carve(C, R, rnd) {
    const floor = new Uint8Array(C * R);
    const rooms = [];
    const tries = 40, want = 5 + (rnd() * 3 | 0);
    while (rooms.length < want && rooms.length < tries) {
      const w = 3 + (rnd() * 5 | 0), h = 3 + (rnd() * 4 | 0);
      const x = 1 + (rnd() * (C - w - 2) | 0), y = 1 + (rnd() * (R - h - 2) | 0);
      if (x < 1 || y < 1 || x + w > C - 1 || y + h > R - 1) continue;
      let overlap = false;
      for (const o of rooms) if (x < o.x + o.w + 1 && x + w + 1 > o.x && y < o.y + o.h + 1 && y + h + 1 > o.y) { overlap = true; break; }
      if (overlap) continue;
      rooms.push({ x, y, w, h, cx: x + (w >> 1), cy: y + (h >> 1) });
      for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) floor[r * C + c] = 1;
    }
    // connect consecutive room centers with L corridors
    for (let i = 1; i < rooms.length; i++) {
      const a = rooms[i - 1], b = rooms[i];
      let cx = a.cx;
      for (; cx !== b.cx; cx += Math.sign(b.cx - cx)) floor[a.cy * C + cx] = 1;
      let cy = a.cy;
      for (; cy !== b.cy; cy += Math.sign(b.cy - cy)) floor[cy * C + b.cx] = 1;
    }
    return { floor, rooms };
  }

  function wallsFromFloor(floor, C, R) {
    const fl = (c, r) => (c < 0 || r < 0 || c >= C || r >= R) ? 0 : floor[r * C + c];
    const vEdge = [], hEdge = [];
    for (let r = 0; r < R; r++) { vEdge[r] = new Uint8Array(C + 1); for (let c = 0; c <= C; c++) vEdge[r][c] = (fl(c - 1, r) ^ fl(c, r)) ? 1 : 0; }
    for (let r = 0; r <= R; r++) { hEdge[r] = new Uint8Array(C); for (let c = 0; c < C; c++) hEdge[r][c] = (fl(c, r - 1) ^ fl(c, r)) ? 1 : 0; }
    return { vEdge, hEdge, C, R };
  }

  // hand-wobble line
  function wline(ctx, x0, y0, x1, y1, jit, rnd) {
    const segs = 4;
    ctx.beginPath();
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const jx = (rnd() - 0.5) * jit, jy = (rnd() - 0.5) * jit;
      const x = x0 + (x1 - x0) * t + jx, y = y0 + (y1 - y0) * t + jy;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function generate(opts) {
    opts = opts || {};
    const seed = opts.seed || 12345;
    const rnd = rng(seed);
    const C = opts.C || 30, R = opts.R || 22, s = opts.cell || 26;
    const ox = opts.ox != null ? opts.ox : 14 + (rnd() * 10 | 0);
    const oy = opts.oy != null ? opts.oy : 14 + (rnd() * 10 | 0);
    const W = ox * 2 + C * s, H = oy * 2 + R * s;

    const { floor, rooms } = carve(C, R, rnd);
    const truth = wallsFromFloor(floor, C, R);

    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    // paper
    ctx.fillStyle = opts.paper || '#f6f1e3'; ctx.fillRect(0, 0, W, H);

    // faint graph grid (he draws squares) — light so walls stand out
    if (opts.grid !== false) {
      ctx.strokeStyle = 'rgba(90,120,140,0.28)'; ctx.lineWidth = 1;
      for (let c = 0; c <= C; c++) { const x = ox + c * s; ctx.beginPath(); ctx.moveTo(x, oy); ctx.lineTo(x, oy + R * s); ctx.stroke(); }
      for (let r = 0; r <= R; r++) { const y = oy + r * s; ctx.beginPath(); ctx.moveTo(ox, y); ctx.lineTo(ox + C * s, y); ctx.stroke(); }
    }

    // optional faint floor tint so rooms read as space
    if (opts.floorTint !== false) {
      ctx.fillStyle = 'rgba(60,60,60,0.05)';
      for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) if (floor[r * C + c]) ctx.fillRect(ox + c * s, oy + r * s, s, s);
    }

    // BOLD walls, hand-wobbled
    ctx.strokeStyle = opts.ink || '#20242b';
    ctx.lineWidth = opts.lw || 3.2; ctx.lineCap = 'round';
    const jit = opts.jitter != null ? opts.jitter : 1.6;
    for (let r = 0; r < R; r++) for (let c = 0; c <= C; c++) if (truth.vEdge[r][c]) wline(ctx, ox + c * s, oy + r * s, ox + c * s, oy + (r + 1) * s, jit, rnd);
    for (let r = 0; r <= R; r++) for (let c = 0; c < C; c++) if (truth.hEdge[r][c]) wline(ctx, ox + c * s, oy + r * s, ox + (c + 1) * s, oy + r * s, jit, rnd);

    // a few glyphs for later (door, stairs, number) — not part of wall truth
    const glyphs = [];
    if (rooms.length) {
      const rm = rooms[0];
      // stairs in room 0
      ctx.lineWidth = 1.6;
      for (let i = 0; i < 5; i++) { const gx = ox + (rm.x + 0.4) * s + i * 5, gy = oy + (rm.y + 0.4) * s; ctx.strokeRect(gx, gy, 4, s * 0.5); }
      glyphs.push({ kind: 'stairs', col: rm.x, row: rm.y });
      // room numbers
      ctx.fillStyle = opts.ink || '#20242b'; ctx.font = `${Math.round(s * 0.5)}px Georgia`;
      rooms.forEach((rm, i) => ctx.fillText(String(i + 1), ox + (rm.cx + 0.2) * s, oy + (rm.cy + 0.7) * s));
    }

    // paper noise + a little blur to mimic a phone photo
    if (opts.noise !== false) {
      const id = ctx.getImageData(0, 0, W, H), d = id.data;
      for (let i = 0; i < d.length; i += 4) { const n = (rnd() - 0.5) * (opts.noiseAmt || 22); d[i] += n; d[i + 1] += n; d[i + 2] += n; }
      ctx.putImageData(id, 0, 0);
    }

    return { canvas: cv, W, H, truth, grid: { s, ox, oy, C, R }, floor, rooms, glyphs };
  }

  window.DS = window.DS || {};
  Object.assign(window.DS, { testgen: generate, wallsFromFloor });
})();
