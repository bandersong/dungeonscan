/*
 * Grid estimation. He draws on a regular lattice, so walls/lines are periodic.
 * We estimate cell pitch by autocorrelating the ink projection, then find the
 * phase (offset) that best lines up with the drawn lines. This is only a STARTING
 * guess — the UI lets the user nudge the overlay to lock it exactly.
 */
(function () {
  'use strict';

  function projections(gray, W, H) {
    const col = new Float64Array(W), row = new Float64Array(H);
    for (let y = 0; y < H; y++) {
      let base = y * W;
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

  // best periodic lag in [lo,hi] by normalized autocorrelation
  function bestPitch(profile, lo, hi) {
    const a = meanSub(profile), n = a.length;
    const ac = (lag) => { let s = 0, c = 0; for (let i = 0; i + lag < n; i++) { s += a[i] * a[i + lag]; c++; } return c ? s / c : 0; };
    let bestLag = lo, bestVal = -Infinity;
    for (let lag = lo; lag <= hi; lag++) { const v = ac(lag); if (v > bestVal) { bestVal = v; bestLag = lag; } }
    // Avoid the octave/harmonic error (picking 2x/3x the true pitch): step down to
    // the fundamental while a sub-multiple is still a strong peak.
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

  // phase (0..pitch-1) that best aligns the comb with the drawn lines
  function bestPhase(profile, pitch) {
    let bestOff = 0, bestSum = -Infinity;
    for (let off = 0; off < pitch; off++) {
      let s = 0;
      for (let x = off; x < profile.length; x += pitch) s += profile[x];
      if (s > bestSum) { bestSum = s; bestOff = off; }
    }
    return bestOff;
  }

  function estimateGrid(gray, W, H, opts) {
    opts = opts || {};
    const lo = opts.minCell || 10;
    const hi = opts.maxCell || Math.round(Math.min(W, H) / 6);
    const { col, row } = projections(gray, W, H);
    const px = bestPitch(col, lo, hi);
    const py = bestPitch(row, lo, hi);
    // trust the stronger axis for a single square pitch (hand-drawn squares ≈ square)
    const s = Math.round((px.strength >= py.strength ? px.pitch : py.pitch));
    const ox = bestPhase(col, s);
    const oy = bestPhase(row, s);
    const C = Math.max(1, Math.floor((W - ox) / s));
    const R = Math.max(1, Math.floor((H - oy) / s));
    return { s, ox, oy, C, R, pitchX: px.pitch, pitchY: py.pitch, confident: Math.min(px.strength, py.strength) > 0 };
  }

  window.DS = window.DS || {};
  Object.assign(window.DS, { estimateGrid, projections });
})();
