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
- [x] real UI integrated into native app bundle (Web/), rebuilt, running
- [x] VTT portal rotation fixed to radians (Foundry convention)
- [~] CoreML glyph classifier (GLM training: 5940 crops done, CreateML training running)
- [~] DevID + MAS build/sign/notarize scripts + README + MAS checklist (GLM running)
- [ ] integrate trained model into bundle + rebuild
- [ ] final signed+notarized DevID build (needs GUI keychain → one script at the Mac) + MAS provisioning
- [ ] Vision OCR room numbers (wired in app.js enrich(), needs model/native to verify)
- [ ] Vision OCR CLI
- [ ] synthetic dataset + CoreML classifier
- [ ] correction UI
- [ ] export + beautify
- [ ] MAS + DevID builds, sign, notarize, verify, launch-test
