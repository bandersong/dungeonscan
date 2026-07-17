// DungeonScan — Vision OCR CLI.
//
// Standalone command-line front-end for the same `VNRecognizeTextRequest`
// path the macOS/iOS app uses in NativeBridge.ocr. Reads a dungeon image
// (photo or scan), prints recognized text + bounding boxes as JSON to
// stdout. Intended for batch/scripted use: scanning a folder of maps, a
// reproducible gate, or piping room-number labels into another tool.
//
// Output JSON mirrors the NativeBridge.ocr shape exactly, so anything that
// consumes the in-app bridge result can consume this too:
//
//   [
//     { "text": "3", "confidence": 0.92,
//       "box": { "x": 0.21, "y": 0.33, "w": 0.04, "h": 0.05 } },
//     ...
//   ]
//
// Coordinates are NORMALIZED (0..1) in TOP-LEFT-origin, image-space — Vision
// reports bottom-left-origin, so Y is flipped (y' = 1 - y - h) to match the
// bridge contract. Multiply by image width/height to get pixels.
//
// Usage:
//   swift tools/main.swift <image-path>            # human-ish JSON to stdout
//   swift tools/main.swift <image-path> --quiet    # JSON only, no stderr banner
//   swift tools/main.swift <image-path> | jq '.[] | .text'
//
// Or build a real binary via the DungeonScan-OCR target in apple/project.yml:
//   cd apple && xcodegen generate
//   xcodebuild -project DungeonScan.xcodeproj -scheme DungeonScan-OCR \
//     -configuration Release build CODE_SIGNING_ALLOWED=NO
//   → apple/build/Build/Products/Release/dsocr <image-path>
//
// The file is named main.swift (not ocr.swift) on purpose: Swift only allows
// top-level statements in a file literally named main.swift, so this same
// source is a valid entry point BOTH for `swift tools/main.swift` script mode
// AND for the Xcode `tool` target above.
//
// Exit codes: 0 ok (even if no text found), 1 usage, 2 unreadable image,
// 3 Vision failed.

import Foundation
import Vision
import CoreGraphics
import ImageIO

// --- args --------------------------------------------------------------------
let argv = CommandLine.arguments
var quiet = false
var imagePath: String? = nil

for arg in argv.dropFirst() {
    if arg == "--quiet" || arg == "-q" { quiet = true }
    else if arg == "--help" || arg == "-h" {
        FileHandle.standardError.write(Data(usage().utf8)); exit(0)
    } else if !arg.hasPrefix("--") {
        imagePath = arg
    }
}
guard let path = imagePath else {
    FileHandle.standardError.write(Data(usage().utf8)); exit(1)
}

let url = URL(fileURLWithPath: path)
guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    FileHandle.standardError.write(Data("ocr: could not read image at \(path)\n".utf8))
    exit(2)
}

if !quiet {
    let w = cg.width, h = cg.height
    FileHandle.standardError.write(Data("ocr: \(path) (\(w)×\(h))\n".utf8))
}

// --- run Vision --------------------------------------------------------------
// Same parameters as NativeBridge.ocr: .accurate, no language correction.
// Language correction off is deliberate — room numbers / short labels get
// "corrected" into dictionary words and misread otherwise.
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false

let handler = VNImageRequestHandler(cgImage: cg, orientation: .up, options: [:])
do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write(Data("ocr: Vision failed — \(error.localizedDescription)\n".utf8))
    exit(3)
}

// --- build JSON (top-left-origin, normalized) --------------------------------
var results: [[String: Any]] = []
for obs in request.results ?? [] {
    guard let cand = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox  // Vision: normalized CGRect, BOTTOM-LEFT origin
    results.append([
        "text": cand.string,
        "confidence": cand.confidence,
        "box": [
            "x": b.origin.x,
            "y": 1.0 - b.origin.y - b.height,  // flip to top-left origin
            "w": b.width,
            "h": b.height,
        ] as [String: Any],
    ])
}

// Sort by reading order (top-to-bottom, then left-to-right) so a folder scan
// or `jq` pipe gets labels in a sensible sequence rather than Vision's
// internal order. Stable on ties.
results.sort { a, b in
    let ay = (a["box"] as? [String: Any])?["y"] as? Double ?? 0
    let by = (b["box"] as? [String: Any])?["y"] as? Double ?? 0
    if abs(ay - by) > 0.01 { return ay < by }      // different line
    let ax = (a["box"] as? [String: Any])?["x"] as? Double ?? 0
    let bx = (b["box"] as? [String: Any])?["x"] as? Double ?? 0
    return ax < bx
}

if !quiet {
    FileHandle.standardError.write(Data("ocr: \(results.count) recognition(s)\n".utf8))
}

// Pretty-printed JSON to stdout; one record per line is tempting but
// downstream tooling (jq, Python) expects a valid JSON document.
let out: [[String: Any]] = results
if let data = try? JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys]),
   let s = String(data: data, encoding: .utf8) {
    print(s)
} else {
    print("[]")
}

// --- helpers -----------------------------------------------------------------
func usage() -> String {
    return """
    DungeonScan OCR — VNRecognizeTextRequest on a dungeon image.

    Usage:
      swift tools/ocr.swift <image-path> [--quiet]
      swift tools/ocr.swift --help

    Output: JSON array of {text, confidence, box:{x,y,w,h}} to stdout.
    Box coords are normalized 0..1, top-left origin (Vision's bottom-left
    origin is flipped to match the in-app NativeBridge.ocr contract).
    """
}
