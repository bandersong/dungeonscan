# DungeonScan

Photograph a hand-drawn **grid** dungeon and DungeonScan rebuilds it as a clean,
usable map: a crisp battle-map PNG at 1"/square **and** a Universal VTT
(`.dd2vtt`) with real walls + doors for **Foundry / Roll20 / Dungeondraft**.
All perception runs **on-device** (Apple Vision OCR + a bundled CoreML
classifier) — fully offline, nothing uploaded.

> You draw the squares; the app reads them.

## What it does

The pipeline (see [`BUILD_PLAN.md`](BUILD_PLAN.md) for the full design):

1. **Import** — drop/paste/open a photo or scan of the hand-drawn dungeon.
2. **Rectify** — 4-corner perspective correct + deskew (auto-suggested, draggable).
3. **Grid detect** — project per-row/column ink to autocorrelate the cell pitch +
   offset; nudge an overlay to lock it to your squares. *The grid is the skeleton.*
4. **Digitize (classical CV, JS)** — for each grid edge, measure ink → wall /
   no-wall; colinear-merge into wall polylines; enclosed cells → floor.
5. **Read features (on-device models)** —
   - **Apple Vision** OCR (`VNRecognizeTextRequest`) → room numbers + labels.
   - **CoreML** glyph classifier (`VNCoreMLRequest` via the bundled
     `DungeonCellClassifier`) → per-cell symbol: door / stairs-up /
     stairs-down / water / rubble / column / trap / statue / altar.
6. **Correct** — overlay the reconstruction on the photo; paint walls/floor,
   drop + rotate doors, fix stairs and numbers. Everything editable.
7. **Export** — battle-map PNG at a chosen px/grid; `.dd2vtt`
   (walls + portals + image); optional *Beautify* pass (the old MapSmith
   engine) for a parchment print version.

## Architecture

DungeonScan is a **native macOS app** (no Electron at runtime): a thin Swift
shell hosts a `WKWebView` that runs the JS computer-vision core, and a native
bridge hands images to Apple Vision / CoreML and back.

```
apple/DungeonScan/
  main.swift          NSApplication + AppDelegate bootstrap (pure AppKit)
  AppDelegate.swift   NSWindow + WKWebView, loads bundled Web/index.html
  NativeBridge.swift  WKScriptMessageHandlerWithReply ("ds") <-> window.native
  Web/                the bundled JS UI + CV core (see renderer/ for the source)
renderer/             the JS CV core (grid, digitize, render, vtt, beautify, …)
training/             synthetic-data generator + CreateML trainer -> CoreML
models/               DungeonCellClassifier (.mlmodel/.mlpackage) + labels.json
```

**NativeBridge** exposes five commands to JS via an injected shim
(`window.native.*`, Promises resolve straight from Swift because the handler is
`WithReply`):

| JS call | Swift | What it does |
|---|---|---|
| `native.openImage()` | `NSOpenPanel` | pick an image → PNG data URL (HEIC/TIFF normalized) |
| `native.saveFile({kind,…})` | `NSSavePanel` | write PNG / `.vtt` / JSON; persists a security-scoped bookmark |
| `native.ocr(image)` | Vision `VNRecognizeTextRequest` | text + bounding boxes (top-left-origin) |
| `native.classify(crops)` | Vision `VNCoreMLRequest` | per-crop `{label, confidence}` |
| `native.capabilities()` | — | `{ocr, classify, ollama}` feature flags |

The CoreML model is loaded **once** from the bundle and degrades gracefully — if
no model is bundled yet, `classify()` returns `{label:"unknown"}` for every crop
rather than erroring. (Bundling the trained model as a resource is the last step
before shipping classification — see *Model & training* below.)

There is **no MLX, no SwiftPM, no Python** — CoreML/Vision need no special
entitlements, which is why the App Sandbox build can drop
`com.apple.security.cs.allow-unsigned-executable-memory` entirely (a tighter
sandbox than a model-runtime app could ship).

## How to build & run

**Prereqs:** Xcode (this Mac has 26.x), `xcodegen`
(`brew install xcodegen`), macOS 13.0+ (the deployment target).

The Xcode project is generated from [`apple/project.yml`](apple/project.yml):

```sh
cd apple
xcodegen generate                       # writes DungeonScan.xcodeproj
```

### Local / unsigned build (just launch it)

```sh
cd apple
xcodebuild -project DungeonScan.xcodeproj -scheme DungeonScan \
  -configuration Release -derivedDataPath build \
  build CODE_SIGNING_ALLOWED=NO
open build/Build/Products/Release/DungeonScan.app
```

This is the ad-hoc build — it compiles and runs but is **not** signed, notarized,
or distributable.

### Distribution channels (run in the Mac's GUI Terminal)

Both scripts use the real signing identities in Jesus's login keychain — so they
**must be run from Terminal.app on the Mac, not over non-GUI ssh** (the keychain
stays locked over ssh). They `echo` each stage and stop hard (`set -eu`) on the
first failure.

| Channel | Script | Output (`dist/`) | Signing |
|---|---|---|---|
| **Developer ID** (direct download) | `apple/build_devid.sh` | signed+notarized+stapled **DMG** + **ZIP** | `Developer ID Application: Jesus Triana (2Y394P797H)`, Hardened Runtime, notarized with the `mapsmith-notary` keychain profile |
| **Mac App Store** | `apple/build_mas.sh` | store **`.pkg`** | `3rd Party Mac Developer Application` + `3rd Party Mac Developer Installer`, App Sandbox, MAS provisioning profile |

```sh
apple/build_devid.sh            # Dev-ID -> dist/DungeonScan-<v>.dmg + .zip
apple/build_mas.sh              # MAS    -> dist/DungeonScan-<v>-mas.pkg (needs the MAS profile/certs)
```

Add `--app` to either to stop after the signed `.app` (skip packaging).

- **Dev-ID** (`build_devid.sh`): `xcodegen → xcodebuild archive (signing + Hardened
  Runtime + entitlements.devid) → exportArchive → codesign/spctl verify → DMG + zip
  → notarytool submit --wait → stapler staple → Gatekeeper verdict`. Ship the
  stapled DMG as the primary download.
- **MAS** (`build_mas.sh`): `xcodegen → install the MAS provisioning profile →
  xcodebuild archive (Apple Distribution + entitlements.mas + MAS profile) →
  exportArchive (mac-application) → productbuild → store .pkg`, then validate +
  upload via `xcrun altool` / Transporter. No notarization step (App Review
  replaces it). See [`MAS_CHECKLIST.md`](MAS_CHECKLIST.md) for the full submission
  list.

Facts: bundle id `io.github.bandersong.dungeonscan` · team `2Y394P797H` ·
notary keychain profile `mapsmith-notary`.

## Model & training

The glyph classifier is a small image classifier trained on **synthetic**
hand-drawn dungeon symbols, then shipped as CoreML.

- **`training/gen_glyphs.py`** — procedurally draws wobbly doors / stairs /
  water / rubble / columns / traps / statues / altars with augmentation
  (rotation, noise, line jitter, paper texture, photo blur) → labeled tiles in
  `training/dataset` and a stratified `training/dataset_split/{train,val}`
  (~15% held-out for validation).
- **`training/train.swift`** — a CreateML `MLImageClassifier` (scenePrint rev2,
  40 iterations, augmentation) trained on that split; prints training + validation
  accuracy and the confusion matrix. Run with `cd training && swift train.swift`
  (override paths with `DS_TRAIN_DIR` / `DS_VAL_DIR`).
- **`models/`** — the trainer writes `DungeonCellClassifier.mlmodel`
  (or `.mlpackage` on newer toolchains); both compile to `.mlmodelc` identically.
  `models/labels.json` is the label set. **Bundle the compiled model as an app
  resource** so `NativeBridge` finds it at `Bundle.main` — without it, the
  `classify` command returns `unknown` (the rest of the app still works).

## OCR CLI

`tools/main.swift` is a standalone command-line front-end for the same
`VNRecognizeTextRequest` path the app runs interactively — for batch/scripted
use (folder scans, reproducible gates, piping room-number labels out).

```sh
swift tools/main.swift datasets/real-maps/bro-03.jpg        # JSON to stdout
swift tools/main.swift datasets/real-maps/bro-03.jpg --quiet  # JSON only
```

Output is a JSON array mirroring the in-app `NativeBridge.ocr` shape:

```json
[{ "text": "3", "confidence": 0.92,
   "box": { "x": 0.21, "y": 0.33, "w": 0.04, "h": 0.05 } }, ...]
```

Box coords are normalized 0..1, **top-left origin** (Vision's native bottom-left
origin is flipped to match the bridge contract). Sorted in reading order.

Or build it as a real binary via the **`DungeonScan-OCR`** Xcode target
(`PRODUCT_NAME=dsocr`):

```sh
cd apple && xcodegen generate
xcodebuild -project DungeonScan.xcodeproj -scheme DungeonScan-OCR \
  -configuration Release build CODE_SIGNING_ALLOWED=NO
apple/build/Build/Products/Release/dsocr <image>
```

The source is a single file named `main.swift` so it works both ways: as a
`swift tools/main.swift` script and as the Xcode `tool` target's entry point.

## Status

The native shell (macOS + iOS), CV core, VTT export, correction UI,
synthetic-data/training pipeline, **and both trained CoreML models bundled
into the app** are all in place. The Dev-ID and MAS build/sign/notarize
scripts are written. Open work is down to two manual gates that need the Mac's
GUI keychain (signing identities don't unlock over ssh): **run the first real
signed+notarized Dev-ID build** (`apple/build_devid.sh` in Terminal.app), and
the **MAS upload** (`apple/build_mas.sh` + the portal steps in
[`MAS_CHECKLIST.md`](MAS_CHECKLIST.md)). See [`BUILD_PLAN.md`](BUILD_PLAN.md)
for the full, current checklist.

## License

MIT — see [`LICENSE`](LICENSE).
