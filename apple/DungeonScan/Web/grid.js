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

  // BUG-A: median line-STRENGTH of the run-length profile (raw cL/rL — long dark runs
  // only) at the s/2-comb midpoint lines relative to the s-comb lattice lines, sampled
  // exactly at the comb positions. Dots/blank midpoints score ~0; a second interleaved
  // wall set scores ~1. This is the spec's "real wall strength, not dot strength" gate.
  function midpointStrength(rawC, s, ox) {
    const n = rawC.length;
    const on = [], mid = [];
    for (let k = 0; ox + k * s < n; k++) on.push(rawC[Math.round(ox + k * s)] || 0);
    for (let k = 0; ox + (k + 0.5) * s < n; k++) mid.push(rawC[Math.round(ox + (k + 0.5) * s)] || 0);
    return (median(mid) || 0) / (median(on) || 1);
  }

  // "Anything that isn't paper" threshold, robust to CLASS IMBALANCE. Otsu
  // collapses when one class dominates: a rectified page (dark desk cropped away)
  // is ~95% paper, so Otsu splits within the paper mode; and bro's pen strokes can
  // be LIGHT (gray 100–170), so an ink/paper midpoint erases them. The line
  // profiles want every mark — stroke, dot, black bar — separated from bare paper,
  // so the threshold sits just below the paper level: paper(p60) minus a step
  // scaled by the paper→ink spread.
  function inkThreshold(gray) {
    const lv = grayLevels(gray);
    if (!lv) return (window.DS && DS.otsu) ? DS.otsu(gray) : 128;
    return Math.round(lv.paper - Math.max(10, 0.12 * (lv.paper - lv.ink)));
  }
  // {paper, ink} luminance levels: paper = bright majority (p60); ink = median of
  // the clearly-darker tail. null when there's no dark tail at all.
  function grayLevels(gray) {
    const n = gray.length;
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[gray[i]]++;
    let acc = 0, paper = 200;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= 0.60 * n) { paper = v; break; } }
    const cut = Math.round(0.7 * paper);
    let dark = 0; for (let v = 0; v < cut; v++) dark += hist[v];
    if (dark < 0.005 * n) return null;
    let ink = cut >> 1, acc2 = 0;
    for (let v = 0; v < cut; v++) { acc2 += hist[v]; if (acc2 >= dark / 2) { ink = v; break; } }
    return { paper, ink };
  }

  // ---- dot-lattice pitch prior ----
  // bro draws on dot-grid Moleskine: the printed dots sit exactly at the drawn-cell
  // corners, so their spacing IS the cell pitch — measurable independently of ink
  // density, hatching, or how many cells he actually ruled. Finds small isolated
  // dark blobs (printed dots: ≤8px across, tiny area), then per-axis takes the
  // median nearest-neighbour spacing among near-colinear dot pairs. The printed
  // dots are LIGHTER than marker ink, so the ink threshold can miss them — we sweep
  // a few thresholds between ink and paper and keep the most regular lattice.
  // Returns {d, n, mad} or null when the page has no usable dot lattice (plain or
  // graph paper, synthetic maps) — callers must treat null as "no prior".
  function dotPitch(gray, W, H) {
    const lv = grayLevels(gray);
    if (!lv) return null;
    // printed dots are GRAY — darker than paper, clearly lighter than marker ink.
    // A band threshold excludes hatch/debris specks (those are ink-black) by physics
    // rather than by shape alone.
    const lo = Math.round(lv.ink + 0.30 * (lv.paper - lv.ink));
    const hi = Math.round(lv.paper - 0.12 * (lv.paper - lv.ink));
    if (hi - lo < 8) return null;
    return dotLatticeAt(gray, W, H, lo, hi);
  }
  function dotLatticeAt(gray, W, H, lo, hi) {
    const MAXA = 48, MAXD = 8; // a printed dot at ≤1600px working scale
    const seen = new Uint8Array(W * H);
    const inBand = (v) => v >= lo && v < hi;
    const cx = [], cy = [];
    const stack = new Int32Array(4096);
    for (let y = 1; y < H - 1; y++) {
      const base = y * W;
      for (let x = 1; x < W - 1; x++) {
        const i0 = base + x;
        if (seen[i0] || !inBand(gray[i0])) continue;
        // flood the component; give up on size overflow but keep consuming it
        let top = 0, n2 = 0, sx = 0, sy = 0, minx = x, maxx = x, miny = y, maxy = y, over = false, touchesInk = false;
        stack[top++] = i0; seen[i0] = 1;
        while (top) {
          const j = stack[--top];
          const jy = (j / W) | 0, jx = j - jy * W;
          n2++; sx += jx; sy += jy;
          if (jx < minx) minx = jx; if (jx > maxx) maxx = jx;
          if (jy < miny) miny = jy; if (jy > maxy) maxy = jy;
          if (n2 > MAXA || maxx - minx > MAXD || maxy - miny > MAXD) over = true;
          const nb = [j - 1, j + 1, j - W, j + W];
          for (const k of nb) {
            if (k < 0 || k >= W * H) continue;
            if (gray[k] < lo) touchesInk = true;   // antialiased rim of a stroke, not a dot
            if (seen[k] || !inBand(gray[k])) continue;
            seen[k] = 1;
            if (over) continue;          // stop growing, we already know it's not a dot
            if (top < stack.length) stack[top++] = k;
          }
        }
        // shape: a dot is compact (fills its bbox, not elongated); stroke rims and
        // slivers aren't. Dots can be only ~2px at working scale, so no hard
        // minimum-side requirement — elongation + fill do the work.
        const bw = maxx - minx + 1, bh = maxy - miny + 1;
        const compact = Math.max(bw, bh) <= 3 * Math.min(bw, bh) && n2 >= 0.45 * bw * bh;
        if (!over && !touchesInk && n2 >= 2 && compact) {
          cx.push(sx / n2); cy.push(sy / n2);
        }
      }
    }
    const N = cx.length;
    if (N < 30 || N > 20000) return null;
    // Pitch from PAIRWISE offsets: histogram Δ along one axis over all
    // near-colinear dot pairs. A true lattice piles mass at d, 2d, 3d…, while
    // stroke-fragment contamination spreads flat — so the spacing between
    // consecutive histogram peaks recovers d even with plenty of junk dots.
    function axisPitch(main, ortho) {
      const MAXLAG = 160;
      const hgm = new Float64Array(MAXLAG);
      const idx = Array.from({ length: N }, (_, i) => i).sort((a2, b2) => ortho[a2] - ortho[b2]);
      for (let a2 = 0; a2 < N; a2++) {
        const i = idx[a2];
        for (let b2 = a2 + 1; b2 < N; b2++) {
          const j = idx[b2];
          if (ortho[j] - ortho[i] > 2.5) break;      // colinear band only
          const dm = Math.abs(main[j] - main[i]);
          if (dm >= 5 && dm < MAXLAG) hgm[Math.round(dm)]++;
        }
      }
      const sm = smooth(hgm, 1);
      // Comb scoring: the true pitch has mass at d, 2d, 3d… simultaneously —
      // junk lags can spike one bin but can't sustain a comb. Score = mean peak
      // mass across the comb teeth; d/2 of the truth dilutes itself on the empty
      // odd teeth, so the comb also self-resolves the half-pitch ambiguity.
      function combScore(d) {
        let s = 0, cnt = 0;
        for (let k = 1; k * d < MAXLAG; k++) { s += maxInWin(sm, k * d, 2); cnt++; }
        return cnt >= 3 ? s / cnt : 0;
      }
      let bestD = 0, bestS = 0;
      for (let d = 10; d <= 80; d++) {
        const s2 = combScore(d);
        if (s2 > bestS) { bestS = s2; bestD = d; }
      }
      if (!bestD) return null;
      // significance: the comb must beat the histogram's typical level clearly
      // (baseline excludes the tiny lags where fragment junk piles up)
      let mean = 0; for (let i = 10; i < MAXLAG; i++) mean += sm[i];
      mean /= (MAXLAG - 10);
      return { d: bestD, score: +(bestS / (mean || 1)).toFixed(2), pass: bestS >= 1.8 * mean };
    }
    const px = axisPitch(cx, cy), py = axisPitch(cy, cx);
    // One clean axis is enough (hatching often buries the other). An axis that
    // fails solo significance still CORROBORATES when its best-fit pitch
    // independently lands on the passing axis's pitch — two junk histograms
    // don't agree by accident.
    let d = null, score = 0;
    const agree = px && py && Math.abs(px.d - py.d) <= 0.15 * Math.max(px.d, py.d);
    if (px && py && px.pass && py.pass) {
      if (agree) { d = (px.d + py.d) / 2; score = Math.max(px.score, py.score); }
      else { const b = px.score >= py.score ? px : py; d = b.d; score = b.score * 0.7; }
    } else if (px && py && (px.pass || py.pass)) {
      const strong = px.pass ? px : py;
      if (agree) { d = (px.d + py.d) / 2; score = strong.score; }
      else { d = strong.d; score = strong.score * 0.8; }
    } else if ((px && px.pass) || (py && py.pass)) {
      const b = px && px.pass ? px : py; d = b.d; score = b.score * 0.8;
    }
    if (!d || d < 8 || score < 1.8) return null;
    // lattice PHASE from the dot centroids: bro draws his walls through the dots,
    // so the dots' modular position pins the grid origin far better than the
    // wobbly ink profiles do. Circular median via the strongest bin of (c mod d).
    function phaseOf(vals) {
      const bins = new Float64Array(Math.ceil(d));
      for (const v of vals) bins[Math.floor(((v % d) + d) % d)]++;
      let best = 0, bi = 0;
      for (let i = 0; i < bins.length; i++) {
        const sc2 = bins[i] + bins[(i + 1) % bins.length] + bins[(i + bins.length - 1) % bins.length];
        if (sc2 > best) { best = sc2; bi = i; }
      }
      return bi;
    }
    return { d, n: N, score: +score.toFixed(2), phaseX: phaseOf(cx), phaseY: phaseOf(cy) };
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
    const thr = inkThreshold(gray);
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
    // Per-axis candidate pitch + half-pitch signals. Does NOT finalize the halve — that
    // needs both axes (see the cross-axis density check below). midRatio is the spec's
    // midpoint WALL-strength gate on the run-length profile.
    function analyzeAxis(rawC, P, gstat, defPitch) {
      const n = P.length;
      let Pmax = 0; for (let i = 0; i < n; i++) if (P[i] > Pmax) Pmax = P[i];
      const base = percentile(P, 0.15);
      let s = gstat ? Math.max(lo, Math.min(maxSize, Math.round(gstat.gap))) : defPitch;
      const ox = originAt(P, s, FR);
      const sc = pitchScores(P, s, ox, FR);
      const prom = (sc.onScore - base) / (Pmax || 1);
      const half = Math.round(s / 2);
      let halfRatio = 0;
      if (half >= 12 && prom >= 0.25 && sc.onScore > base) {
        const sc2 = pitchScores(P, half, originAt(P, half, FR), FR);
        // s/2 places ~2× as many lattice lines, so compare TOTAL captured prominence.
        halfRatio = (2 * (sc2.onScore - base)) / (sc.onScore - base);
      }
      return { s, half, halfRatio, prom, midRatio: midpointStrength(rawC, s, ox),
               reg: ratio(gstat), Pmax, base, sc };
    }

    const gc = gapStats(findPeaks(cS, MD, FR));
    const gr = gapStats(findPeaks(rS, MD, FR));
    const def = Math.round(Math.min(W, H) / 12);
    const ax = analyzeAxis(cL, cS, gc, def);   // columns → x origin
    const ay = analyzeAxis(rL, rS, gr, def);   // rows    → y origin

    // BUG-A half-pitch decision. A halve is genuine only when (1) the s/2-comb midpoint
    // lines carry real WALL strength — >= STR× the lattice lines on the run-length profile
    // (dots / blank midpoints fail this) — AND (2) the 2x structure is ASYMMETRIC across
    // the two axes. A map whose BOTH axes show equally strong s/2 midpoint structure is
    // densely drawn: those midpoints are interior texture / a paper sub-grid, not a finer
    // cell lattice, so we keep the coarser pitch. This is what stops bro-02 (dense on both
    // axes) over-halving to ~28 while still halving bro-04 / bro-05 (a real 2x lock on a
    // single axis). SYM only applies when both axes actually detected a lattice.
    const STR = 0.5, SYM = 0.8;
    const bothStrong = gc && gr && ax.midRatio >= SYM && ay.midRatio >= SYM;
    const halve = (x) => !bothStrong && x.half >= 12 && x.prom >= 0.25 && x.sc.onScore > x.base
                        && x.halfRatio >= 1.2 && x.midRatio >= STR;
    ax.halved = halve(ax); ay.halved = halve(ay);

    // combine to one pitch (his cells are square): agree → mean; disagree with a halve
    // → take the finer; otherwise trust the more regular axis.
    const a = ax.halved ? ax.half : ax.s, b = ay.halved ? ay.half : ay.s;
    const big = Math.max(a, b), small = Math.min(a, b);
    let s;
    if (big <= 1.15 * small) s = Math.round((a + b) / 2);
    else if (ax.halved || ay.halved) s = small;
    else s = (ax.reg >= ay.reg) ? a : b;

    // Dot-lattice prior: bro rules his cells ON the printed dots — on every real
    // map the drawn cell pitch IS the dot pitch (verified per map on zoomed
    // overlays; the tempting "he subdivides the dots" readings were all optical
    // illusions at low zoom). So a confident dot lattice simply wins: it is
    // direct physical evidence, independent of ink density, hatching, or how the
    // half-pitch heuristics happen to land. Dotless paper (plain/graph/synthetic)
    // → dots=null → line-profile behaviour unchanged.
    const dots = dotPitch(gray, W, H);
    let dotSnap = false;
    if (dots && dots.d >= 12 && dots.d <= maxSize) { s = Math.round(dots.d); dotSnap = true; }
    s = Math.max(12, Math.min(maxSize, s));

    // origin: the dot phase is authoritative when the lattice was detected —
    // bro draws his walls through the printed dots, and the wobbly ink profiles
    // routinely land the comb half a cell off, which starves the wall detector.
    const ox = dotSnap ? dots.phaseX : originAt(cS, s, FR);
    const oy = dotSnap ? dots.phaseY : originAt(rS, s, FR);
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
    // a dot-lattice match is physical corroboration — worth more than projection shape
    if (dotSnap) confidence = Math.max(confidence, Math.min(1, confidence + 0.2, 0.85));

    return {
      s, ox, oy, C, R, confidence, confident: confidence >= 0.5,
      dbg: { sX: ax.s, sY: ay.s, halved: [ax.halved, ay.halved],
             onScore: [scX.onScore, scY.onScore], midScore: [scX.midScore, scY.midScore],
             prom: [ax.prom, ay.prom], halfRatio: [ax.halfRatio, ay.halfRatio],
             midRatio: [ax.midRatio, ay.midRatio], midFrac, reg: [rc, rr],
             dotPitch: dots ? +dots.d.toFixed(1) : null, dotN: dots ? dots.n : 0, dotSnap }
    };
  }

  window.DS = window.DS || {};
  Object.assign(window.DS, { estimateGrid, projections, dotPitch });
})();
