import AppKit
import CoreML
import ImageIO
import PDFKit
import UniformTypeIdentifiers
import Vision
import WebKit

/// Native bridge between the Web UI and the macOS host.
///
/// Registered as the `WKScriptMessageHandlerWithReply` named "ds". A JS shim
/// (injected at document start, see `shim`) exposes `window.native.<cmd>(...)`
/// whose Promises resolve here. Because it is WithReply, `postMessage` returns
/// the reply Promise directly — no manual `evaluateJavaScript` plumbing (the
/// ScrubBuddy bridge uses the older WKScriptMessageHandler + manual resolve;
/// this is the cleaner 11.0+ API).
///
/// NO MLX. OCR is Apple Vision (VNRecognizeTextRequest) and cell classification
/// is CoreML (VNCoreMLRequest) via a bundled DungeonCellClassifier model when
/// present. CoreML/Vision need no special entitlements, so the MAS build drops
/// `com.apple.security.cs.allow-unsigned-executable-memory` entirely.
@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let dict = message.body as? [String: Any], let cmd = dict["cmd"] as? String else {
            replyHandler(nil, "DungeonScan: malformed message (expected {cmd, ...})")
            return
        }
        switch cmd {
        case "openImage":    openImage(replyHandler)
        case "rasterizePdf": rasterizePdf(dict, replyHandler)
        case "openProject":  openProject(replyHandler)
        case "saveFile":     saveFile(dict, replyHandler)
        case "ocr":          ocr(dict, replyHandler)
        case "classify":     classify(dict, replyHandler)
        case "predictGrid":  predictGrid(dict, replyHandler)
        case "vlm":          vlm(dict, replyHandler)
        case "capabilities": replyHandler(capabilities(), nil)
        default:             replyHandler(nil, "DungeonScan: unknown cmd \(cmd)")
        }
    }

    // MARK: - Commands

    /// {cmd:"openImage"} -> NSOpenPanel (png/jpg/jpeg/heic/heif/tiff/gif/webp/pdf).
    /// Returns {name, dataUrl}. Any raster format is normalized to a PNG data URL
    /// (HEIC/TIFF/etc via CGImageSource); a PDF (e.g. exported from an iPad drawing
    /// app) has its first page rasterized to a white-backed PNG. {} if the user
    /// cancels.
    private func openImage(_ reply: @escaping (Any?, String?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.png, .jpeg, .heic, .heif, .tiff, .gif, .webP, .pdf]
        panel.prompt = "Open"

        guard panel.runModal() == .OK, let url = panel.url else { reply([:], nil); return }

        do {
            let dataUrl: String?
            if url.pathExtension.lowercased() == "pdf" {
                dataUrl = pdfFirstPagePNGDataURL(from: url)
            } else {
                dataUrl = pngDataURL(from: try Data(contentsOf: url))
            }
            guard let du = dataUrl else {
                reply(nil, "DungeonScan: could not read \(url.lastPathComponent)")
                return
            }
            reply(["name": url.lastPathComponent, "dataUrl": du], nil)
        } catch {
            reply(nil, "DungeonScan: read failed — \(error.localizedDescription)")
        }
    }

    /// {cmd:"rasterizePdf", dataUrl:"data:application/pdf;base64,…"} -> {dataUrl}.
    /// Used for drag-and-dropped PDFs (the Open panel rasterizes on its own). The
    /// first page is rendered to a white-backed PNG data URL. {nil,error} on failure.
    private func rasterizePdf(_ dict: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let durl = dict["dataUrl"] as? String, let data = dataFromDataURL(durl),
              let doc = PDFDocument(data: data), let page = doc.page(at: 0),
              let out = pdfPageToPNGDataURL(page) else {
            reply(nil, "DungeonScan: could not read that PDF"); return
        }
        reply(["dataUrl": out], nil)
    }

    /// {cmd:"openProject"} -> NSOpenPanel (.dungeonscan / .json) -> {name, text}.
    /// Reads the file as UTF-8 text and hands it back to the JS layer, which
    /// DS.project.deserialize parses back into full working state. {} on cancel.
    private func openProject(_ reply: @escaping (Any?, String?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [UTType.json,
                                     UTType(filenameExtension: "dungeonscan") ?? UTType.plainText]
        panel.prompt = "Open project"

        guard panel.runModal() == .OK, let url = panel.url else { reply([:], nil); return }
        do {
            let text = try String(contentsOf: url, encoding: .utf8)
            reply(["name": url.lastPathComponent, "text": text], nil)
        } catch {
            reply(nil, "DungeonScan: could not read project — \(error.localizedDescription)")
        }
    }

    /// {cmd:"saveFile", suggestedName, kind ("png"|"vtt"|"json"), dataUrl?, text?}
    /// -> NSSavePanel -> write. PNG is written from the base64 dataUrl; vtt/json
    /// from `text`. Persists a security-scoped bookmark to the chosen URL so a
    /// later launch can resolve it under App Sandbox (mirrors ScrubBuddy's
    /// AppController.swift:176 bookmarkData(.withSecurityScope)). Returns
    /// {ok, path}; {ok:false} if cancelled.
    private func saveFile(_ p: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let kind = p["kind"] as? String else {
            reply(nil, "DungeonScan: saveFile needs a kind (png|vtt|json|txt)"); return
        }
        let suggested = (p["suggestedName"] as? String) ?? defaultName(kind)

        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggested
        panel.allowedContentTypes = uttype(for: kind)
        panel.prompt = "Save"

        guard panel.runModal() == .OK, let url = panel.url else { reply(["ok": false], nil); return }

        // Persist a security-scoped bookmark (sandbox-safe future access).
        if let bookmark = try? url.bookmarkData(options: .withSecurityScope,
                                               includingResourceValuesForKeys: nil,
                                               relativeTo: nil) {
            UserDefaults.standard.set(bookmark, forKey: "ds.bookmark." + url.path)
        }

        do {
            switch kind {
            case "png":
                guard let durl = p["dataUrl"] as? String, let png = dataFromDataURL(durl) else {
                    reply(nil, "DungeonScan: saveFile png needs a dataUrl"); return
                }
                try png.write(to: url)
            case "vtt", "json", "txt", "dungeonscan":
                guard let text = p["text"] as? String else {
                    reply(nil, "DungeonScan: saveFile \(kind) needs text"); return
                }
                try text.write(to: url, atomically: true, encoding: .utf8)
            default:
                reply(nil, "DungeonScan: unknown save kind \(kind)"); return
            }
            reply(["ok": true, "path": url.path], nil)
        } catch {
            reply(nil, "DungeonScan: write failed — \(error.localizedDescription)")
        }
    }

    /// {cmd:"ocr", image (dataURL)} -> Vision VNRecognizeTextRequest
    /// (.accurate, usesLanguageCorrection=false) -> [{text, confidence,
    /// box:{x,y,w,h}}] in NORMALIZED TOP-LEFT-origin coords. Vision's native
    /// boundingBox is bottom-left-origin, so Y is flipped (y' = 1 - y - h).
    private func ocr(_ p: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let durl = p["image"] as? String,
              let data = dataFromDataURL(durl),
              let cg = cgImage(from: data) else {
            reply(nil, "DungeonScan: ocr needs a valid image data URL"); return
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false

        let handler = VNImageRequestHandler(cgImage: cg, orientation: .up, options: [:])
        do { try handler.perform([request]) } catch {
            reply(nil, "DungeonScan: OCR failed — \(error.localizedDescription)"); return
        }

        var results: [[String: Any]] = []
        for obs in request.results ?? [] {
            guard let cand = obs.topCandidates(1).first else { continue }
            let b = obs.boundingBox  // normalized CGRect, bottom-left origin
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
        reply(results, nil)
    }

    /// {cmd:"classify", crops:[dataURL...], model?} -> run VNCoreMLRequest on
    /// each crop via the bundled CoreML model named by `model`
    /// ("TerrainClassifier" -> Resources/TerrainClassifier.mlmodelc, otherwise
    /// Resources/DungeonCellClassifier.mlmodelc; either may be a source .mlmodel
    /// compiled on the fly) -> [{label, confidence}]. If that model isn't bundled
    /// yet, every crop gets {label:"unknown", confidence:0} — graceful, not an error.
    private func classify(_ p: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        let crops = (p["crops"] as? [String]) ?? []
        let modelName = (p["model"] as? String) ?? "DungeonCellClassifier"

        guard let model = self.model(named: modelName) else {
            reply(crops.map { _ in ["label": "unknown", "confidence": 0.0] as [String: Any] }, nil)
            return
        }

        var out: [[String: Any]] = []
        out.reserveCapacity(crops.count)
        for crop in crops {
            guard let data = dataFromDataURL(crop), let cg = cgImage(from: data) else {
                out.append(["label": "unknown", "confidence": 0.0]); continue
            }
            // VNCoreMLRequest(model:) is not throwing. Crops are small (e.g.
            // 64x64) while the model's image input is RGB 360x360 (scenePrint
            // rev2); .scaleFill upscales each crop to fill 360x360 (crops are
            // square, so no aspect distortion).
            let request = VNCoreMLRequest(model: model)
            request.imageCropAndScaleOption = .scaleFill
            let handler = VNImageRequestHandler(cgImage: cg, orientation: .up, options: [:])
            do { try handler.perform([request]) } catch {
                out.append(["label": "unknown", "confidence": 0.0]); continue
            }
            if let best = request.results?.first as? VNClassificationObservation {
                out.append(["label": best.identifier, "confidence": best.confidence])
            } else {
                out.append(["label": "unknown", "confidence": 0.0])
            }
        }
        reply(out, nil)
    }

    /// {cmd:"predictGrid", image:dataURL} -> run the GridNet regressor and return
    /// [Double] of 9 values: 4 grid corners (TL,TR,BR,BL, each x,y normalized 0..1)
    /// then cell size / max(image side). null if GridNet isn't bundled (JS falls back
    /// to the classical detector). The model input is a 320x320 RGB image; .scaleFill
    /// matches training (square resize), and Vision does the resize + /255 scaling.
    private func predictGrid(_ p: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let durl = p["image"] as? String,
              let data = dataFromDataURL(durl), let cg = cgImage(from: data),
              let model = self.model(named: "GridNet") else { reply(nil, nil); return }
        let request = VNCoreMLRequest(model: model)
        request.imageCropAndScaleOption = .scaleFill
        let handler = VNImageRequestHandler(cgImage: cg, orientation: .up, options: [:])
        do { try handler.perform([request]) } catch { reply(nil, nil); return }
        guard let obs = request.results?.first as? VNCoreMLFeatureValueObservation,
              let arr = obs.featureValue.multiArrayValue else { reply(nil, nil); return }
        var out: [Double] = []
        out.reserveCapacity(arr.count)
        for i in 0..<arr.count { out.append(arr[i].doubleValue) }
        reply(out, nil)
    }

    /// {cmd:"vlm", image (dataURL), prompt} -> POST the crop + prompt to the
    /// optional local vision-LLM (Ollama, Developer-ID build only) at
    /// http://127.0.0.1:11434/api/generate and return its `.response` string.
    /// 180s timeout. On ANY failure (no model image, bad data URL, network
    /// error, non-2xx, missing `response`) returns null — graceful, the UI
    /// simply treats VLM notes as unavailable. Async: replies from the
    /// URLSession completion handler.
    private func vlm(_ p: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let durl = p["image"] as? String,
              let prompt = p["prompt"] as? String,
              let b64 = Self.bareBase64(from: durl) else {
            reply(nil, nil); return
        }
        guard let url = URL(string: "http://127.0.0.1:11434/api/generate") else {
            reply(nil, nil); return
        }

        let body: [String: Any] = [
            "model": "qwen2.5vl",
            "prompt": prompt,
            "images": [b64],          // raw base64, no data: prefix
            "stream": false,
        ]
        guard let payload = try? JSONSerialization.data(withJSONObject: body) else {
            reply(nil, nil); return
        }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 180
        req.httpBody = payload

        // Dedicated session with a 180s cap. The completion handler captures
        // only `reply` (no self), so it stays off the MainActor.
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 180
        cfg.timeoutIntervalForResource = 180
        let session = URLSession(configuration: cfg)

        session.dataTask(with: req) { data, response, error in
            guard error == nil,
                  let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let resp = obj["response"] as? String else {
                reply(nil, nil); return
            }
            reply(resp, nil)
        }.resume()
    }

    private func capabilities() -> [String: Any] {
        return [
            "ocr": true,
            "classify": model(named: "DungeonCellClassifier") != nil,
            "terrain": model(named: "TerrainClassifier") != nil,
            "grid": model(named: "GridNet") != nil,
            // Optional local vision-LLM (Ollama, Developer-ID build only).
            // Probed synchronously with a 1s timeout — resolves in a few ms
            // when ollama serve is up, ~1s otherwise.
            "ollama": Self.ollamaReachable(),
        ]
    }

    // MARK: - CoreML models (loaded once, cached by name)

    /// Cache of bundled classifiers keyed by base resource name
    /// ("DungeonCellClassifier", "TerrainClassifier"). Both ship in Resources.
    private var _modelCache: [String: VNCoreMLModel] = [:]

    /// Resolve a bundled classifier by its base resource name, caching the
    /// loaded VNCoreMLModel. Accepts a pre-compiled .mlmodelc, or a source
    /// .mlmodel (compiled at runtime). nil when the named model isn't bundled —
    /// callers fall back gracefully.
    private func model(named name: String) -> VNCoreMLModel? {
        if let cached = _modelCache[name] { return cached }
        let b = Bundle.main
        if let url = b.url(forResource: name, withExtension: "mlmodelc"),
           let ml = try? MLModel(contentsOf: url),
           let vm = try? VNCoreMLModel(for: ml) {
            _modelCache[name] = vm
            return vm
        }
        if let url = b.url(forResource: name, withExtension: "mlmodel"),
           let compiled = try? MLModel.compileModel(at: url),
           let ml = try? MLModel(contentsOf: compiled),
           let vm = try? VNCoreMLModel(for: ml) {
            _modelCache[name] = vm
            return vm
        }
        return nil
    }

    // MARK: - JS shim

    /// Injected at document start. `postMessage` returns the reply Promise
    /// directly because "ds" is a WKScriptMessageHandlerWithReply. `nonisolated`
    /// so the AppDelegate's webview setup (not main-actor-isolated) can read it.
    nonisolated static let shim = """
    (function () {
      function call(payload) {
        return window.webkit.messageHandlers.ds.postMessage(payload);
      }
      window.native = {
        openImage:    function ()             { return call({ cmd: 'openImage' }); },
        rasterizePdf: function (dataUrl)      { return call({ cmd: 'rasterizePdf', dataUrl: dataUrl }); },
        openProject:  function ()             { return call({ cmd: 'openProject' }); },
        saveFile:     function (o)            { return call(Object.assign({ cmd: 'saveFile' }, o || {})); },
        ocr:          function (image)        { return call({ cmd: 'ocr', image: image }); },
        classify:     function (crops, model) { return call({ cmd: 'classify', crops: crops, model: model }); },
        predictGrid:  function (image)        { return call({ cmd: 'predictGrid', image: image }); },
        vlm:          function (image, prompt){ return call({ cmd: 'vlm', image: image, prompt: prompt }); },
        capabilities: function ()             { return call({ cmd: 'capabilities' }); }
      };
    })();
    """

    // MARK: - Helpers

    private func defaultName(_ kind: String) -> String {
        switch kind {
        case "png":  return "DungeonScan.png"
        case "vtt":  return "DungeonScan.vtt"
        case "json": return "DungeonScan.json"
        case "txt":  return "DungeonScan-notes.txt"
        default:     return "DungeonScan-output"
        }
    }

    private func uttype(for kind: String) -> [UTType] {
        switch kind {
        case "png":         return [.png]
        case "json":        return [UTType.json]
        case "vtt":         return [UTType(filenameExtension: "vtt") ?? .plainText]
        case "txt":         return [UTType.plainText]
        case "dungeonscan": return [UTType(filenameExtension: "dungeonscan") ?? UTType.json]
        default:            return [.data]
        }
    }

    /// Decode a `data:image/...;base64,....` URL to its raw bytes.
    private func dataFromDataURL(_ durl: String) -> Data? {
        guard let comma = durl.firstIndex(of: ",") else { return nil }
        return Data(base64Encoded: String(durl[durl.index(after: comma)...]))
    }

    /// Return the raw base64 segment of a `data:...;base64,....` URL (everything
    /// after the first comma), for Ollama's `images` array which wants base64
    /// with NO data-URL prefix.
    nonisolated private static func bareBase64(from durl: String) -> String? {
        guard let comma = durl.firstIndex(of: ",") else { return nil }
        return String(durl[durl.index(after: comma)...])
    }

    /// Synchronous reachability probe for the local Ollama server. Returns true
    /// only if GET http://127.0.0.1:11434/api/version answers 2xx within ~1s.
    /// Runs on the URLSession's own queue + a semaphore, so it never deadlocks
    /// the main thread even though it blocks the caller briefly.
    nonisolated private static func ollamaReachable() -> Bool {
        guard let url = URL(string: "http://127.0.0.1:11434/api/version") else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.0
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 1.0
        cfg.timeoutIntervalForResource = 1.0
        let session = URLSession(configuration: cfg)

        let sem = DispatchSemaphore(value: 0)
        var ok = false
        session.dataTask(with: req) { _, response, error in
            if error == nil,
               let http = response as? HTTPURLResponse,
               (200..<300).contains(http.statusCode) {
                ok = true
            }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 1.5)
        return ok
    }

    /// Build a CGImage from arbitrary image bytes (HEIC/TIFF/PNG/JPEG/GIF/WebP).
    private func cgImage(from data: Data) -> CGImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(src, 0, nil)
    }

    /// Normalize any decodable image to a PNG `data:` URL (HEIC/TIFF/etc -> PNG).
    private func pngDataURL(from data: Data) -> String? {
        guard let cg = cgImage(from: data) else { return nil }
        let rep = NSBitmapImageRep(cgImage: cg)
        guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
        return "data:image/png;base64," + png.base64EncodedString()
    }

    private func pdfFirstPagePNGDataURL(from url: URL) -> String? {
        guard let doc = PDFDocument(url: url), let page = doc.page(at: 0) else { return nil }
        return pdfPageToPNGDataURL(page)
    }

    /// Rasterize a PDF page to a white-backed PNG `data:` URL. PDFs are transparent
    /// and vector; the digitizer wants a flat paper-white raster, so we fill white
    /// and render the page scaled so its long edge is ~`maxDim`px (never upscaling
    /// past 4x a tiny source). Both PDF and CGBitmapContext use a bottom-left
    /// origin, so no y-flip is needed.
    private func pdfPageToPNGDataURL(_ page: PDFPage, maxDim: CGFloat = 2400) -> String? {
        let box = page.bounds(for: .mediaBox)
        guard box.width > 0, box.height > 0 else { return nil }
        let scale = min(max(maxDim / max(box.width, box.height), 1.0), 4.0)
        let w = Int((box.width * scale).rounded()), h = Int((box.height * scale).rounded())
        guard w > 0, h > 0,
              let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.saveGState()
        ctx.scaleBy(x: scale, y: scale)
        ctx.translateBy(x: -box.minX, y: -box.minY)
        page.draw(with: .mediaBox, to: ctx)
        ctx.restoreGState()
        guard let cg = ctx.makeImage() else { return nil }
        let rep = NSBitmapImageRep(cgImage: cg)
        guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
        return "data:image/png;base64," + png.base64EncodedString()
    }
}
