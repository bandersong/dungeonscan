# DungeonScan datasets

## real-maps/
Real hand-drawn dungeon maps from the primary tester ("bro"). Dot-grid Moleskine
paper, heavy hatching/vegetation texture, marker walls, **non-uniform hand-drawn
squares**, and most are **angled phone photos** (perspective distortion). 2160×2880.

These are the ground-truth-in-waiting for pushing digitization toward one-shot.

## Why the current pipeline fails on these (diagnosed 2026-07-12)
`estimateGrid` (renderer/grid.js) autocorrelates the ink projection to find the
cell pitch. On bro's maps it collapses:
- The raw ink projection is dominated by the **hatching envelope**, so the
  autocorrelation is a monotonic decay with **no peak at the true pitch**.
- It therefore returns the **floor of the search range (10px)** = the dot-grid
  dot spacing → a 119×159 grid of garbage, reported `confident:true`.

Prototyping (run-length line profiles that keep only long vertical/horizontal
dark runs — real ruled lines — and drop dots + short hatch strokes) removes the
dot-lock, but **no single global pitch is stable** across these maps because of
perspective + non-uniform squares. Evidence: tuning variants swing a given map
between 20px and 98px.

## Plan toward one-shot (sequenced)
1. **Auto perspective-rectify first.** Detect the page/grid quad and de-warp so
   the grid is axis-aligned and pitch is constant. Biggest single lever; angled
   photos are bro's norm.
   → **DONE 2026-07-16**: `DS.perspective.autoRectify` (gated) runs on import.
2. **Grid by line-detection + local snap** (not global autocorrelation): find the
   actual ruled-line positions, cluster them, snap a possibly-slightly-irregular
   grid. Robust to non-uniform hand squares.
   → **Superseded by the dot-lattice prior (2026-07-16)**: bro rules his cells ON
   the printed dots — on all 5 maps the drawn cell pitch equals the dot pitch
   (verified on zoomed overlays; low-zoom eyeballs mis-read pitch by 2× in both
   directions, repeatedly). `estimateGrid` detects the dot lattice (gray-band
   compact blobs → pairwise-Δ comb) and snaps the pitch to it; plus an
   imbalance-robust ink threshold (post-rectify histograms break Otsu).
   Regression gates: `node tools/realgate.js` (headless, frozen expectations
   28/48/41/45/40) and `renderer/harness-real.html` (browser twin) — both 5/5.
2b. **Open: pale-stroke recall on sparse thin-pen maps (bro-01).** Wall read at
   2026-07-16 close: 29 enclosed cells vs ~250 drawn — his palest strokes sit
   ~10-15 gray levels under paper, the SAME local darkness as photo/paper
   texture. Threshold + continuity tuning was tried and REVERTED (delta 10 +
   followed-run rescue lanes recovered pale strokes but dropped synthetic wall
   F1 99.1→93.7 — texture chains just like a pale line). The separator has to
   be GEOMETRY, not darkness: a pen stroke is a curvilinear ridge with a
   consistent direction; texture is isotropic. Next attempt = ridge/stroke
   tracing (skeletonize locally-dark ink → polylines → snap to lattice edges),
   gated by `tools/realgate.js` + labeled bro-01 wall truth.
3. **Build a labeled set** from these maps using the (improved) app: digitize →
   hand-correct → save `.dungeonscan`. That yields real (image, grid, walls,
   floor, doors) truth = thousands of labeled cells/edges from 5 maps.
4. **Retrain the cell/edge classifier on REAL crops** (the existing CoreML
   `DungeonCellClassifier` is synthetic-trained). This is the actual "train a
   model" win — it depends on 1–3.

Grid geometry (steps 1–2) is signal processing, not a job for a learned model.
Cell/edge semantics (step 4) is where training on real ink pays off.

## Mac ML environment (source of truth: `ssh mac`)
- Apple M2 Max, 64 GB unified, 12-core. Heavy data → `/Volumes/2TB` (backup of
  real-maps lives at `/Volumes/2TB/DungeonScan/real-maps`) or `/Volumes/BEAST`.
- MLX + torch + transformers venvs: `~/mlx-env`, `~/scrubbuddy/.venv`
  (mlx 0.31, torch 2.12, transformers 5.1). coremltools available for CoreML export.
- Cached: gpt-oss-20b (MXFP4), Qwen3-30B-A3B-4bit, Qwen2.5-7B/1.5B. Prior
  fine-tuning precedent: `~/scrubbuddy/distill/`.
