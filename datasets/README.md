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
2. **Grid by line-detection + local snap** (not global autocorrelation): find the
   actual ruled-line positions, cluster them, snap a possibly-slightly-irregular
   grid. Robust to non-uniform hand squares.
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
