# Experiment round 2026-07-17 — four frontier lanes, adversarially verified

Four parallel investigations, each with an independent adversarial re-run of
the numbers (all four reproduced, none refuted). Scripts live in `tools/`;
every run confirmed `node tools/realgate.js` = 5/5 before AND after. Read
[RESEARCH.md](RESEARCH.md) first for the literature these lanes test.

## 1. Pitch divergence 41/42/44 (node/Chromium/WKWebView) — DIAGNOSED, not a bug

Script: `tools/exp-divergence.js`

The same bro-03.jpg photo reads pitch 41 in the node gate, 42 in Chromium, 44
in the native WKWebView app. Root cause is NOT our math: the scale formula in
`setupImage()` is byte-identical everywhere, bro-03 has no EXIF orientation,
and devicePixelRatio is never applied. What differs is each platform's native
**image-resampling filter** for the identical MAXDIM=1600 downscale (ImageIO
one-step vs Skia vs CoreGraphics — canvas `drawImage` smoothing is
implementation-defined by spec, nothing in this repo controls it).

Holding everything byte-identical and swapping ONLY the resample filter
reproduces the full spread: sips → 41, naive bilinear → 41, nearest → 43,
box/area → 44 — with identical confidence (0.85), rect and deskew. The
sensitivity only exists on borderline-confidence maps (conf 0.67–0.85);
bro-01 (0.91) and bro-05 (1.0) move ≤1px across all filters. Every variant
still locks the SAME real lattice — no ×2 harmonic error anywhere, so output
correctness is unaffected and the zoom+nudge UI already covers the ±2px.

The verifier independently reran the real Chromium pipeline
(`harness-real.html`) and got s=42 exactly.

**If cross-platform numeric reproducibility ever matters** (e.g. a shared
cloud gate): replace `drawImage` downscale with the portable JS box-average
from the experiment script, and loosen realgate TOL for conf<0.9 maps.
Not applied — not warranted today.

## 2. HPS/SHS octave disambiguation on raw projections — CLEAN KILL

Script: `tools/exp-hps.js`

RESEARCH.md hypothesis: harmonic reinforcement (HPS-multiply / subharmonic
summation) on the raw ink-projection autocorrelation could fix the external
×2 failures. **Falsified.** All four variants fix 0/3 external ×2 failures,
break the bro gate 4–5/5, and HPS-multiply even flips a previously-passing
external (dyson-pit 33→50). Diagnostic: score(truth)/score(argmax) spans
0.42–1.04 — the true pitch is NEVER the dominant peak of the raw projection
ACF on these maps, so no harmonic reweighting of that signal can save it.

**Surviving next idea (untried):** run the same harmonic test on the signal
the shipping detector actually uses — grid.js's run-length line-profile
scores (`cS`/`rS`), not the raw ink ACF. The dot-comb's success suggests the
comb belongs on a line-structured signal, not raw ink.

## 3. Structure-tensor coherence for pale strokes — NOT separable as-is

Script: `tools/exp-coherence.js`

RESEARCH.md's cheapest falsifier, run before touching `detectWalls`: is
aggregate structure-tensor coherence separable between pale wall strokes,
dark strokes, hatch texture, and blank paper? **Mostly no:** best F1 for
pale-wall vs hatch = 0.67 (precision 0.50) — unusable as a gate — and on
bro-03 unidirectional hatch runs score HIGHER median coherence (0.541) than
detected walls (0.387), exactly the risk RESEARCH.md predicted.

Two genuinely useful signals survived:
- Visually-confirmed pale strokes just under the ink threshold (score
  69.8–70.6 vs thr 74) land at coherence 0.94–0.96 — above hatch's p90
  (0.867) — separable **if** the window isolates the stroke.
- Only ~15% of elevated-but-subthreshold ink candidates are real strokes;
  ink score alone is a poor pale-stroke proxy, coherence splits that
  candidate pool bimodally (≥0.85 vs <0.3).

**Next step (cheap, defined):** re-run with orientation-ALIGNMENT — accept a
candidate edge only when the window's dominant orientation lies within
~15–20° of the edge direction. Hatch is coherent but misaligned; walls are
coherent AND aligned. Only if that separates cleanly does a `detectWalls`
change get designed.

## 4. UVTT round-trip audit — exports spec-clean; foundry-json had real bugs

Script: `tools/vttcheck.js` (strict validator with `--self-test`; encodes the
importer contract from Arkenforge's spec + the actual FVTT-DD-Import source)

All five real `.dd2vtt` exports: **0 errors, 0 warnings** — units, bounds,
portal geometry, PNG dims all consistent. Importer-contract facts worth
keeping: dd-import does zero validation (missing `resolution` = hard crash),
walls with BOTH endpoints outside the map are silently dropped, only
`portals[].bounds` is read (position/rotation ignored), `environment.*` is
functionally inert.

Real bugs found in the separate `foundry-json` path — fixed in PR #4:
walls exported with `WALL_SENSE_TYPES.NONE` (blocked nothing) and
`grid.distance: 1` (rulers read 5× short).

Latent (inert today, will bite when features ship): `toFoundryScene` ignores
`objects_line_of_sight`, `lights`, and `map_origin`; `hexToVTT` emits a
non-spec `grid` key and hex-width ppg no real importer understands.
