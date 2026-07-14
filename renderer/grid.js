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
  // with L ≤ run ≤ maxRun (a ruled line spans a cell; dots/hatch are shorter; a page
  // border bar spans the whole image). Rows: horizontal runs.
  function lineProfiles(gray, W, H, thr, L, maxRun) {
    const cL = new Float64Array(W), rL = new Float64Array(H);
    for (let x = 0; x < W; x++) {
      let run = 0;
      for (let y = 0; y < H; y++) { if (gray[y * W + x] < thr) run++; else { if (run >= L && run <= maxRun) cL[x] += run; run = 0; } }
      if (run >= L && run <= maxRun) cL[x] += run;
    }
    for (let y = 0; y < H; y++) {
      let run = 0, b = y * W;
      for (let x = 0; x < W; x++) { if (gray[b + x] < thr) run++; else { if (run >= L && run <= maxRun) rL[y] += run; run = 0; } }
      if (run >= L && run <= maxRun) rL[y] += run;
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
  function percentile(arr, frac) { if (!arr.length) return 0; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(frac * a.length))]; }

  // ---- half-pitch disambiguation helpers (Fix 1) ----
  // The line profiles cL/rL already suppress dots + hatch (only runs ≥ L count),
  // so all of these operate on the SMOOTHED line profile P, never raw ink: a printed
  // dot can't fake a long-run peak, so it can't trigger a false halve.

  // max value of P within ±win around center c (clamped to range)
  function maxInWin(P, c, win) {
    const n = P.length;
    const lo = Math.max(0, Math.round(c - win)), hi = Math.min(n - 1, Math.round(c + win));
    let mx = 0; for (let i = lo; i <= hi; i++) if (P[i] > mx) mx = P[i];
    return mx;
  }
  // is there a clear local maximum of P within ±win of c rising above thr?
  function hasClearMax(P, c, win, thr) {
    const n = P.length;
    const lo = Math.max(1, Math.round(c - win)), hi = Math.min(n - 2, Math.round(c + win));
    for (let i = lo; i <= hi; i++) if (P[i] >= P[i - 1] && P[i] > P[i + 1] && P[i] >= thr) return true;
    return false;
  }
  // phase (origin offset) aligning a comb of pitch s to P's strongest lines
  function originAt(P, s, FR) {
    const peaks = findPeaks(P, Math.round(s * 0.55), FR);
    return peaks.length ? (peaks[0] % s) : 0;
  }
  // onScore  = median of (max of P within ±0.15s) sampled at each lattice line ox+k*s
  // midScore = same sampled at each midpoint ox+(k+0.5)*s; midClear counts midpoints
  // that carry a clear local max. High midScore ⇒ a second interleaved line set ⇒ s/2.
  function pitchScores(P, s, ox, FR) {
    const n = P.length, win = 0.15 * s;
    let Pmax = 0; for (let i = 0; i < n; i++) if (P[i] > Pmax) Pmax = P[i];
    const clear = FR * Pmax;
    const on = [], mid = []; let midClear = 0;
    for (let k = 0; ox + k * s < n; k++) on.push(maxInWin(P, ox + k * s, win));
    for (let k = 0; ox + (k + 0.5) * s < n; k++) {
      const m = ox + (k + 0.5) * s;
      mid.push(maxInWin(P, m, win));
      if (hasClearMax(P, m, win, clear)) midClear++;
    }
    return { onScore: median(on) || 0, midScore: median(mid) || 0, midClear, Pmax };
  }

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
    const maxSize = Math.round(Math.min(W, H) / 4);
    const thr = (window.DS && DS.otsu) ? DS.otsu(gray) : 128;
    // L ≈ min/26 keeps runs of roughly a cell or more; maxRun ≈ min/2 drops page-border
    // bars (full-dimension runs) that would otherwise saturate the profile. FR keeps
    // only tall (wall) peaks.
    const L = Math.round(Math.min(W, H) / 26);
    const maxRun = Math.round(0.5 * Math.min(W, H));
    const { cL, rL } = lineProfiles(gray, W, H, thr, L, maxRun);
    const cS = smooth(cL, 2), rS = smooth(rL, 2);
    const FR = 0.38, MD = Math.round(L * 0.5);
    const ratio = (g) => (g && g.peaks.length > 1) ? g.reg / (g.peaks.length - 1) : 0;

    // Per-axis half-pitch disambiguation. A 2x lock keeps the comb on the heavy
    // every-other walls while a second, lighter line set sits at the midpoints — so a
    // comb at s/2 captures that extra ink. We measure "captured prominence" = how far
    // the lattice lines rise above the profile baseline; halving a 2x-locked axis
    // captures ~2× the per-line prominence worth of extra lines (totalRatio ≥ 1.2),
    // while halving an already-correct axis captures nothing. A FLAT map (bro-01) has
    // near-zero prominence everywhere, so we gate on prominence first — its tiny wall
    // modulation can't trigger a halve even though s/2 "lines" sit at the same height.
    // Dots never enter this: they're suppressed in P (runs < L).
    function analyzeAxis(P, gstat, defPitch) {
      const n = P.length;
      let Pmax = 0; for (let i = 0; i < n; i++) if (P[i] > Pmax) Pmax = P[i];
      const base = percentile(P, 0.15);
      let s = gstat ? Math.max(lo, Math.min(maxSize, Math.round(gstat.gap))) : defPitch;
      const ox = originAt(P, s, FR);
      const sc = pitchScores(P, s, ox, FR);
      const prom = (sc.onScore - base) / (Pmax || 1);
      let halved = false, halfRatio = 0;
      const half = Math.round(s / 2);
      if (half >= 12 && prom >= 0.25 && sc.onScore > base) {
        const sc2 = pitchScores(P, half, originAt(P, half, FR), FR);
        // s/2 places ~2× as many lattice lines, so compare TOTAL captured prominence.
        halfRatio = (2 * (sc2.onScore - base)) / (sc.onScore - base);
        if (halfRatio >= 1.2) { s = half; halved = true; }
      }
      return { s, halved, reg: ratio(gstat), Pmax, base, prom, halfRatio, sc };
    }

    const gc = gapStats(findPeaks(cS, MD, FR));
    const gr = gapStats(findPeaks(rS, MD, FR));
    const def = Math.round(Math.min(W, H) / 12);
    const ax = analyzeAxis(cS, gc, def);   // columns → x origin
    const ay = analyzeAxis(rS, gr, def);   // rows    → y origin

    // combine to one pitch (his cells are square): agree → mean; disagree with a halve
    // → take the finer; otherwise trust the more regular axis.
    const a = ax.s, b = ay.s;
    const big = Math.max(a, b), small = Math.min(a, b);
    let s;
    if (big <= 1.15 * small) s = Math.round((a + b) / 2);
    else if (ax.halved || ay.halved) s = small;
    else s = (ax.reg >= ay.reg) ? a : b;
    s = Math.max(12, Math.min(maxSize, s));

    const ox = originAt(cS, s, FR);
    const oy = originAt(rS, s, FR);
    const C = Math.max(1, Math.floor((W - ox) / s));
    const R = Math.max(1, Math.floor((H - oy) / s));

    // confidence recomputed at the FINAL pitch so a halved grid is judged on its true
    // lines. Same regularity-based score as before (a correct, regular grid scores
    // well; a 2x-off grid only stays regular if we FAILED to halve it). Add the
    // spec's ambiguity cap: if we did not halve and the midpoints look half-populated,
    // the pitch is suspect — cap it.
    const scX = pitchScores(cS, s, ox, FR);
    const scY = pitchScores(rS, s, oy, FR);
    const gcf = gapStats(findPeaks(cS, Math.round(s * 0.55), FR));
    const grf = gapStats(findPeaks(rS, Math.round(s * 0.55), FR));
    const rc = ratio(gcf), rr = ratio(grf);
    const bothAgree = gcf && grf && Math.abs(gcf.gap - grf.gap) / Math.max(gcf.gap, grf.gap) <= 0.15;
    // how strongly the lattice sits on the profile's dominant lines (best axis)
    const onFracBest = Math.max(scX.onScore / (scX.Pmax || 1), scY.onScore / (scY.Pmax || 1));
    // Regularity at the final pitch is the core honesty signal: a correct, regular grid
    // scores well; a 2x-off grid only stays regular if we FAILED to halve it. His cells
    // are square, so one well-detected axis is enough — and a halve is positive evidence
    // the pitch is right (it resolved a 2x ambiguity), so a halved grid is not penalised
    // for landing on a single clean axis. A single axis that is nonetheless locked onto
    // the dominant lines (high onFrac) is still trustworthy.
    let confidence;
    if (bothAgree) confidence = Math.min(1, (rc + rr) / 2 + 0.15);
    else if (ax.halved || ay.halved) confidence = Math.min(1, Math.max(rc, rr) + 0.1);
    else confidence = Math.min(1, Math.max(rc, rr) * 0.7 + Math.max(0, onFracBest - 0.5) * 0.5);
    const midFrac = (scX.midScore / (scX.onScore || 1) + scY.midScore / (scY.onScore || 1)) / 2;
    if (!(ax.halved || ay.halved) && midFrac >= 0.4 && midFrac <= 0.55)
      confidence = Math.min(confidence, 0.6);

    return {
      s, ox, oy, C, R, confidence, confident: confidence >= 0.5,
      dbg: { sX: ax.s, sY: ay.s, halved: [ax.halved, ay.halved],
             onScore: [scX.onScore, scY.onScore], midScore: [scX.midScore, scY.midScore],
             prom: [ax.prom, ay.prom], halfRatio: [ax.halfRatio, ay.halfRatio], midFrac,
             reg: [rc, rr] }
    };
  }

  window.DS = window.DS || {};
  Object.assign(window.DS, { estimateGrid, projections });
})();
