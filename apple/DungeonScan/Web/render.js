/*
 * Clean battle-map renderer. Takes the digitized walls/floor/doors and draws a
 * crisp, grid-aligned map at `ppg` pixels per cell — the "ready to use" output,
 * and the base image embedded in the .dd2vtt.
 */
(function () {
  'use strict';

  const STYLES = {
    stone: { void: '#1b1e24', floor: '#d9ccb0', floorEdge: '#c7b78f', grid: 'rgba(60,50,30,0.18)', wall: '#1b1e24', door: '#7a5230' },
    blueprint: { void: '#0d2f52', floor: '#123a63', floorEdge: '#0f3157', grid: 'rgba(150,190,225,0.35)', wall: '#eaf3ff', door: '#8fb4dd' },
    ink: { void: '#ffffff', floor: '#ffffff', floorEdge: '#f0efe9', grid: 'rgba(40,40,40,0.16)', wall: '#161616', door: '#161616' }
  };

  function renderBattleMap(opts) {
    const { walls, floor, doors = [], C, R } = opts;
    const ppg = opts.ppg || 80;
    const st = STYLES[opts.style] || STYLES.stone;
    const W = C * ppg, H = R * ppg;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');

    // void
    ctx.fillStyle = st.void; ctx.fillRect(0, 0, W, H);
    // floor cells
    ctx.fillStyle = st.floor;
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) if (floor[r * C + c]) ctx.fillRect(c * ppg, r * ppg, ppg, ppg);
    // grid over floor
    ctx.strokeStyle = st.grid; ctx.lineWidth = Math.max(1, ppg / 60);
    for (let c = 0; c <= C; c++) { ctx.beginPath(); ctx.moveTo(c * ppg, 0); ctx.lineTo(c * ppg, H); ctx.stroke(); }
    for (let r = 0; r <= R; r++) { ctx.beginPath(); ctx.moveTo(0, r * ppg); ctx.lineTo(W, r * ppg); ctx.stroke(); }

    // doors first (so walls can gap around them visually)
    const doorSet = new Set(doors.map((d) => d.kind + d.col + '_' + d.row));

    // walls (skip door edges — they read as openings)
    ctx.strokeStyle = st.wall; ctx.lineWidth = Math.max(2.5, ppg * 0.11); ctx.lineCap = 'square';
    for (let r = 0; r < R; r++) for (let c = 0; c <= C; c++) if (walls.vEdge[r][c] && !doorSet.has('v' + c + '_' + r)) {
      ctx.beginPath(); ctx.moveTo(c * ppg, r * ppg); ctx.lineTo(c * ppg, (r + 1) * ppg); ctx.stroke();
    }
    for (let r = 0; r <= R; r++) for (let c = 0; c < C; c++) if (walls.hEdge[r][c] && !doorSet.has('h' + c + '_' + r)) {
      ctx.beginPath(); ctx.moveTo(c * ppg, r * ppg); ctx.lineTo((c + 1) * ppg, r * ppg); ctx.stroke();
    }

    // doors
    ctx.fillStyle = st.door; ctx.strokeStyle = st.wall; ctx.lineWidth = Math.max(1.5, ppg * 0.05);
    for (const d of doors) {
      const th = ppg * 0.26;
      if (d.kind === 'h') { const x = d.col * ppg, y = d.row * ppg; ctx.fillRect(x + ppg * 0.14, y - th / 2, ppg * 0.72, th); ctx.strokeRect(x + ppg * 0.14, y - th / 2, ppg * 0.72, th); }
      else { const x = d.col * ppg, y = d.row * ppg; ctx.fillRect(x - th / 2, y + ppg * 0.14, th, ppg * 0.72); ctx.strokeRect(x - th / 2, y + ppg * 0.14, th, ppg * 0.72); }
    }

    // stamps (icons) + room numbers passed through as features
    for (const f of opts.features || []) {
      if (f.kind === 'number') {
        ctx.fillStyle = st.wall; ctx.font = `bold ${Math.round(ppg * 0.5)}px Georgia`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(f.label), (f.col + 0.5) * ppg, (f.row + 0.5) * ppg);
      }
    }
    return cv;
  }

  window.DS = window.DS || {};
  Object.assign(window.DS, { renderBattleMap, STYLES });
})();
