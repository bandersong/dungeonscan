/*
 * Grid estimation. He draws his dungeon as ruled squares on dot paper. Earlier
 * versions autocorrelated the ink projection to find the cell pitch, but on real
 * hand-drawn maps that collapses: heavy vegetation hatching swamps the projection
 * (no periodic peak) and the search floors out on the ~10px dot-grid spacing,
 * emitting a garbage 100+×100+ grid, confidently.
 *
 * This version finds the actual RULED LINES instead. Real grid lines are LONG
 * straight ink runs spanning a whole cell or more; dots are tiny and hatch strokes
 * are short and slanted — so both drop out under a run-length filter, and the tall
 * remaining peaks are the walls. Cell size = the spacing between those lines. Since
 * bro's squares are square, the two axes should agree; when they don't we trust the
 * more regular one. This is still a STARTING guess — the UI lets the user zoom and
 * nudge to lock it exactly, and `confidence` tells the app when to ask them to check.
 */
(function () {
  'use strict';

  // ink projections (kept: hexgrid.js reuses this for hex pitch)
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

  // Per-axis "line strength": for each column, total length of vertical dark runs
  // ≥ L (a ruled line spans a cell; dots/hatch are shorter). Rows: horizontal runs.
  function lineProfiles(gray, W, H, thr, L) {
    const cL = new Float64Array(W), rL = new Float64Array(H);
    for (let x = 0; x < W; x++) {
      let run = 0;
      for (let y = 0; y < H; y++) { if (gray[y * W + x] < thr) run++; else { if (run >= L) cL[x] += run; run = 0; } }
      if (run >= L) cL[x] += run;
    }
    for (let y = 0; y < H; y++) {
      let run = 0, b = y * W;
      for (let x = 0; x < W; x++) { if (gray[b + x] < thr) run++; else { if (run >= L) rL[y] += run; run = 0; } }
      if (run >= L) rL[y] += run;
    }
    return { cL, rL };
  }

  function smooth(a, r) {
    const n = a.length, out = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let d = -r; d <= r; d++) { const j = i + d; if (j >= 0 && j < n) { s += a[j]; c++; } } out[i] = s / c; }
    return out;
  }

  // local maxima ≥ frac·max, non-max-suppressed within minDist (greedy by height)
  function findPeaks(a, minDist, frac) {
    const n = a.length; let mx = 0; for (let i = 0; i < n; i++) if (a[i] > mx) mx = a[i];
    if (mx <= 0) return [];
    const thr = frac * mx, cands = [];
    for (let i = 1; i < n - 1; i++) if (a[i] >= a[i - 1] && a[i] > a[i + 1] && a[i] >= thr) cands.push(i);
    cands.sort((p, q) => a[q] - a[p]);
    const taken = new Uint8Array(n), chosen = [];
    for (const c of cands) {
      let ok = true;
      for (let d = -minDist; d <= minDist; d++) { const j = c + d; if (j >= 0 && j < n && taken[j]) { ok = false; break; } }
      if (ok) { chosen.push(c); taken[c] = 1; }
    }
    chosen.sort((p, q) => p - q);
    return chosen;
  }

  function median(arr) { if (!arr.length) return null; const a = arr.slice().sort((x, y) => x - y); return a[a.length >> 1]; }

  // {gap, reg, peaks}: robust median line spacing + how many gaps match it (±20%)
  function gapStats(peaks) {
    if (peaks.length < 3) return null;
    const gaps = []; for (let i = 1; i < peaks.length; i++) gaps.push(peaks[i] - peaks[i - 1]);
    const m0 = median(gaps);
    const kept = gaps.filter((g) => g >= 0.6 * m0 && g <= 1.6 * m0);
    const gap = median(kept) || m0;
    const reg = gaps.filter((g) => g >= 0.8 * gap && g <= 1.2 * gap).length;
    return { gap, reg, peaks };
  }

  function estimateGrid(gray, W, H, opts) {
    opts = opts || {};
    const lo = Math.max(14, Math.round(Math.min(W, H) / 60));
    const thr = (window.DS && DS.otsu) ? DS.otsu(gray) : 128;
    // L ≈ min/26 keeps runs of roughly a cell or more; FR keeps only tall (wall) peaks.
    const L = Math.round(Math.min(W, H) / 26);
    const { cL, rL } = lineProfiles(gray, W, H, thr, L);
    const cS = smooth(cL, 2), rS = smooth(rL, 2);
    const FR = 0.38, MD = Math.round(L * 0.5);
    const gc = gapStats(findPeaks(cS, MD, FR));
    const gr = gapStats(findPeaks(rS, MD, FR));
    const ratio = (g) => (g && g.peaks.length > 1) ? g.reg / (g.peaks.length - 1) : 0;

    let s, confidence;
    if (gc && gr && Math.abs(gc.gap - gr.gap) / Math.max(gc.gap, gr.gap) <= 0.15) {
      s = Math.round((gc.gap + gr.gap) / 2);
      confidence = Math.min(1, (ratio(gc) + ratio(gr)) / 2 + 0.15);
    } else {
      const best = [gc, gr].filter(Boolean).sort((a, b) => ratio(b) - ratio(a))[0];
      s = best ? Math.round(best.gap) : Math.round(Math.min(W, H) / 12);
      confidence = best ? ratio(best) * 0.7 : 0;   // single-axis answers are less certain
    }
    s = Math.max(lo, Math.min(Math.round(Math.min(W, H) / 4), s));

    // phase: align the comb to the actual strong lines at the chosen scale
    const cP = findPeaks(cS, Math.round(s * 0.55), FR);
    const rP = findPeaks(rS, Math.round(s * 0.55), FR);
    const ox = cP.length ? (cP[0] % s) : 0;
    const oy = rP.length ? (rP[0] % s) : 0;
    const C = Math.max(1, Math.floor((W - ox) / s));
    const R = Math.max(1, Math.floor((H - oy) / s));
    return { s, ox, oy, C, R, confidence, confident: confidence >= 0.5 };
  }

  window.DS = window.DS || {};
  Object.assign(window.DS, { estimateGrid, projections });
})();
