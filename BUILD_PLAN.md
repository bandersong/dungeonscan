# DungeonScan — build plan (autonomous)

**What it does:** photograph a hand-drawn GRID dungeon (he draws the squares) → the app
*reads* it and rebuilds a clean, usable map: a crisp battle-map PNG at 1"/square **and** a
Universal VTT (`.dd2vtt`) with real walls + doors for Foundry/Roll20/Dungeondraft.
On-device models on his M4 do the "reading." Fully offline.

**Machines:** laptop = thin client (edit + rsync + orchestrate). Main Mac = everything heavy
(GLM fan-out, model training, `npm`, builds, sign/notarize, tests). Repo authoritative on the
Mac at `~/DungeonScan`; I stage edits on the laptop and rsync.

## Pipeline
1. **Import** photo/scan (drag/drop, file, or paste).
2. **Rectify** — 4-corner perspective correct + deskew (auto-suggest, user drags corners).
3. **Grid detect** — estimate cell pitch + offset (projection autocorrelation); user nudges an
   overlay to lock it to his squares. *This is the key: the grid is the skeleton.*
4. **Digitize (geometry, classical CV, JS — Claude-owned):** for each grid EDGE, measure ink →
   wall / no-wall. Colinear merge → wall polylines. Enclosed cell regions → floor.
5. **Read features (on-device models):**
   - Apple **Vision** OCR (native Swift CLI) → room numbers + labels.
   - **CoreML glyph classifier** (trained on synthetic data, Neural Engine, MAS-safe) → per detected
     symbol: door / stairs-up / stairs-down / water / rubble / column / trap / statue / altar.
   - Optional **Ollama VLM** backend (Developer-ID build only) → richer semantics + legend text.
   - Backend abstraction in `models.js`: `vision`(always) + `coreml`(bundled) + `ollama`(optional).
6. **Correct** — overlay reconstruction on the photo; user paints walls/floor, drops/rotates doors,
   fixes stairs + numbers. Everything editable. Hand-holding.
7. **Export** — battle-map PNG @ chosen px/grid; `.dd2vtt` (walls+portals+image); optional
   *Beautify* pass (reuse `beautify.js` = old MapSmith engine) for a parchment print version.

## Distribution (dual target)
- **Developer ID** dmg/zip (already have signing+notarize working) — allows Ollama backend.
- **Mac App Store** (`mas` target): App Sandbox entitlements, no external process spawning →
  uses only Vision + bundled CoreML (sandbox-safe). Needs 3rd Party Mac Developer certs +
  provisioning profile (user provides in GUI). `build/entitlements.mas.plist` + inherit.

## Model training (on main Mac — informed by ScrubBuddy stack, GLM brief pending)
- Generate large **synthetic** hand-drawn dungeon glyph dataset (GLM fan-out — massively parallel):
  procedurally draw wobbly doors/stairs/water/etc. with augmentation (rotation, noise, line jitter,
  paper texture, photo blur) → labeled tiles.
- Train a small image classifier → **CoreML** (`.mlpackage`) via his existing pipeline (CreateML or
  coremltools/MLX → coreml). Bundle in app; run on Neural Engine.

## Work split
- **Claude (me, minimal tokens):** architecture, grid math, wall/floor CV, VTT exporter, model
  interface, integration, verification.
- **GLM (main Mac, fanned out hard):** ScrubBuddy knowledge mining; synthetic-data generators +
  the whole dataset; boilerplate modules; UI controls + copy; Swift OCR CLI draft; docs; tests.

## Status
- [x] scaffold + reuse infra
- [x] PIVOT: native Swift + WKWebView (ScrubBuddy pattern) + CoreML/Vision (GLM brief confirmed)
- [x] wall/floor digitize + VTT export — **PROVEN: 99.1% wall F1, 100% recall, VTT valid 4/4**
- [x] grid auto-estimate (auto-lock 3/4; user confirms)
- [x] Swift shell BUILT + LAUNCHES: xcodegen project, WKWebView, NativeBridge (Vision OCR + CoreML classify) — shim matches bridge.js; WebContent process live, no CSP/JS errors
- [x] real UI: import → **auto-deskew** → lock grid → read → CORRECT (walls/floor/doors) → export PNG + .dd2vtt
- [x] auto-deskew PROVEN: exact angle recovery ±0.0°, identical digitize results -4°..+7° (real phone photos handled)
- [x] REAL-MAP GRID SOLVED (2026-07-16): auto perspective-rectify on import (datasets/README step 1)
      + dot-lattice pitch prior (his cell pitch = the printed dot pitch on EVERY real map, zoom-verified)
      + imbalance-robust ink threshold (Otsu collapses after rectify crops the dark desk away).
      Gate: 5/5 real maps at zoom-verified pitch (`node tools/realgate.js`, renderer/harness-real.html)
      AND synthetic auto-lock 4/4 (was 3/4), wall F1 99.1% unchanged. Old commit-message pitches mixed
      scales and were never zoom-checked — treat only the frozen gate expectations as truth.
- [x] real UI integrated into native app bundle (Web/), rebuilt, running
- [x] VTT portal rotation fixed to radians (Foundry convention)
- [x] CoreML glyph classifier — **two models trained + shipped**:
      `DungeonCellClassifier` (cell symbols: door/stairs/water/…) and
      `TerrainClassifier`. Sources in `models/`, training pipeline in
      `training/` (`gen_*.py`, `train.swift`, `verify_*.py`). Bundled as
      compiled `.mlmodelc` resources.
- [x] DevID + MAS + iOS build/sign/notarize scripts written —
      `apple/build_devid.sh`, `apple/build_mas.sh`, `apple/build_ios.sh`.
      README + `MAS_CHECKLIST.md` cover the manual portal steps.
- [x] trained model integrated into the bundle + rebuild verified —
      both `.mlmodelc` + `labels.json` are `resources` in `apple/project.yml`
      (macOS + iOS targets) and land in `Contents/Resources/`;
      `NativeBridge.model(named:)` loads them by name.
- [x] Vision OCR room numbers — `VNRecognizeTextRequest` in
      `NativeBridge.ocr` + wired into `app.js enrich()` (reads numbers when
      `caps.ocr` is true). Capabilities flag reported in the UI badge.
- [x] synthetic dataset + CoreML classifier — generator + trainer + verifier
      pipeline all present (`training/gen_glyphs.py`, `train.swift`,
      `verify_cells*.py`, `export_coreml.py`).
- [x] correction UI — paint walls/floor, drop + rotate doors, fix
      stairs/numbers, edit everything (`renderer/app.js`).
- [x] export + beautify — `renderer/export.js` (PNG/JPEG/WebP/PDF +
      tiled-print PDF), `renderer/vtt.js` (`.dd2vtt`), `renderer/beautify.js`
      (parchment print pass = old MapSmith engine).
- [ ] Vision OCR CLI — a standalone Swift CLI that runs the same
      `VNRecognizeTextRequest` on a file (for batch/scripted use). Not yet
      written; the in-app bridge covers interactive use.
- [ ] final signed+notarized DevID build + MAS upload — **needs the Mac's
      GUI keychain** (signing identities unlock only in an interactive
      Terminal session, not over ssh). Run `apple/build_devid.sh` and
      `apple/build_mas.sh` on the Mac, then the MAS steps in
      `MAS_CHECKLIST.md`. This is the last manual gate before shipping.
