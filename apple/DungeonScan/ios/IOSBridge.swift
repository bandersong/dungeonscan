import CoreML
import ImageIO
import PDFKit
import PhotosUI
import UIKit
import UniformTypeIdentifiers
import Vision
import WebKit

/// Native bridge between the Web UI and the iOS host.
///
/// Registered as the `WKScriptMessageHandlerWithReply` named "ds". A JS shim
/// (injected at document start, see `shim`) exposes `window.native.<cmd>(...)`
/// whose Promises resolve here. Because it is WithReply, `postMessage` returns
/// the reply Promise directly — no manual `evaluateJavaScript` plumbing.
///
/// This is the iOS counterpart of the macOS `NativeBridge`: Vision OCR,
/// CoreML classification, and PDFKit rasterization are copied VERBATIM (the
/// frameworks are identical cross-platform). Only the file/image commands
/// differ — macOS uses NSOpenPanel/NSSavePanel, iOS uses UIAlertController +
/// UIImagePickerController / PHPickerViewController / UIDocumentPickerViewController
/// + UIActivityViewController. The optional Ollama VLM is dropped (always null)
/// since there is no local server on iOS, and `capabilities` reports ollama:false.
///
/// NO MLX. OCR is Apple Vision (VNRecognizeTextRequest) and cell classification
/// is CoreML (VNCoreMLRequest) via a bundled DungeonCellClassifier model when
/// present. CoreML/Vision need no special entitlements.
@MainActor
final class IOSBridge: NSObject, WKScriptMessageHandlerWithReply,
                       UIImagePickerControllerDelegate, UINavigationControllerDelegate,
                       PHPickerViewControllerDelegate, UIDocumentPickerDelegate {

    /// Weak ref to the presenting controller (the WebViewController). Set by the
    /// controller so this bridge can present pickers/sheets off its window.
    weak var presentingController: UIViewController?

    /// Weak ref to the webview, used only to anchor iPad popover sourceViews
    /// (the share sheet / action sheet crash on iPad without one).
    weak var webView: WKWebView?

    /// Stored reply for an in-flight openImage flow (camera / photo / files all
    /// resolve this single closure). Modal, so at most one is pending at a time.
    private var pendingImageReply: ((Any?, String?) -> Void)?

    /// Stored reply for an in-flight openProject flow (document picker).
    private var pendingProjectReply: ((Any?, String?) -> Void)?

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
        case "vlm":          vlm(dict, replyHandler)
        case "capabilities": replyHandler(capabilities(), nil)
        default:             replyHandler(nil, "DungeonScan: unknown cmd \(cmd)")
        }
    }

    // MARK: - Commands

    /// {cmd:"openImage"} -> UIAlertController action sheet ("Take Photo" /
    /// "Choose Photo" / "Files"). Take Photo -> UIImagePickerController(.camera)
    /// if the device has a camera; Choose Photo -> PHPickerViewController (single
    /// image); Files -> UIDocumentPickerViewController([.image, .pdf]). The
    /// picked image is normalized to a PNG data URL; a PDF has its first page
    /// rasterized to a white-backed PNG. Returns {name, dataUrl}, {} on cancel.
    /// Delegate callbacks resolve the stored `pendingImageReply`.
    private func openImage(_ reply: @escaping (Any?, String?) -> Void) {
        guard let presenter = topController() else {
            reply(nil, "DungeonScan: no window to present picker"); return
        }
        pendingImageReply = reply

        let sheet = UIAlertController(title: "Import Map", message: nil, preferredStyle: .actionSheet)
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            sheet.addAction(UIAlertAction(title: "Take Photo", style: .default) { [weak self] _ in
                self?.presentCamera(from: presenter)
            })
        }
        sheet.addAction(UIAlertAction(title: "Choose Photo", style: .default) { [weak self] _ in
            self?.presentPhotoPicker(from: presenter)
        })
        sheet.addAction(UIAlertAction(title: "Files…", style: .default) { [weak self] _ in
            self?.presentImageFilesPicker(from: presenter)
        })
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
            self?.resolveImage(nil, name: nil, cancel: true)
        })
        // iPad: an action sheet without a popover sourceView crashes.
        configurePopover(sheet)
        presenter.present(sheet, animated: true)
    }

    /// {cmd:"rasterizePdf", dataUrl:"data:application/pdf;base64,…"} -> {dataUrl}.
    /// Used for drag-and-dropped PDFs (the picker rasterizes on its own). The
    /// first page is rendered to a white-backed PNG data URL. {nil,error} on failure.
    private func rasterizePdf(_ dict: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let durl = dict["dataUrl"] as? String, let data = dataFromDataURL(durl),
              let doc = PDFDocument(data: data), let page = doc.page(at: 0),
              let out = pdfPageToPNGDataURL(page) else {
            reply(nil, "DungeonScan: could not read that PDF"); return
        }
        reply(["dataUrl": out], nil)
    }

    /// {cmd:"openProject"} -> UIDocumentPickerViewController (.dungeonscan /
    /// .json) -> {name, text}. Reads the file as UTF-8 text and hands it back to
    /// the JS layer, which DS.project.deserialize parses back into full working
    /// state. {} on cancel.
    private func openProject(_ reply: @escaping (Any?, String?) -> Void) {
        guard let presenter = topController() else {
            reply(nil, "DungeonScan: no window to present picker"); return
        }
        pendingProjectReply = reply
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.json,
                UTType(filenameExtension: "dungeonscan") ?? .plainText], asCopy: true)
        picker.delegate = self
        picker.allowsMultipleSelection = false
        presenter.present(picker, animated: true)
    }

    /// {cmd:"saveFile", suggestedName, kind ("png"|"vtt"|"json"), dataUrl?, text?}
    /// -> write the payload to a temp URL in the caches dir, then present a
    /// UIActivityViewController (share sheet) so the user saves to Files/Photos/etc.
    /// PNG is written from the base64 dataUrl; vtt/json/txt from `text`. Replies
    /// {ok:true} once the sheet is presented. On iPad the popover is anchored to
    /// the webview (a sourceless share sheet crashes on iPad).
    private func saveFile(_ p: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let kind = p["kind"] as? String else {
            reply(nil, "DungeonScan: saveFile needs a kind (png|vtt|json|txt)"); return
        }
        let suggested = (p["suggestedName"] as? String) ?? defaultName(kind)

        // Temp file in the caches dir; the share sheet hands it off to the
        // destination (Files, Photos, AirDrop, …). No sandbox bookmark needed.
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
                     ?? URL(fileURLWithPath: NSTemporaryDirectory())
        let fileURL = caches.appendingPathComponent(suggested)

        do {
            switch kind {
            case "png":
                guard let durl = p["dataUrl"] as? String, let png = dataFromDataURL(durl) else {
                    reply(nil, "DungeonScan: saveFile png needs a dataUrl"); return
                }
                try png.write(to: fileURL)
            case "vtt", "json", "txt", "dungeonscan":
                guard let text = p["text"] as? String else {
                    reply(nil, "DungeonScan: saveFile \(kind) needs text"); return
                }
                try text.write(to: fileURL, atomically: true, encoding: .utf8)
            default:
                reply(nil, "DungeonScan: unknown save kind \(kind)"); return
            }
        } catch {
            reply(nil, "DungeonScan: write failed — \(error.localizedDescription)"); return
        }

        guard let presenter = topController() else {
            reply(nil, "DungeonScan: no window to present share sheet"); return
        }
        let share = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
        // iPad: a share sheet presented without a popover sourceView crashes.
        configurePopover(share)
        presenter.present(share, animated: true)
        reply(["ok": true], nil)
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

    /// {cmd:"vlm", image, prompt} -> always null on iOS. The optional local
    /// vision-LLM (Ollama, Developer-ID macOS build only) has no server here; the
    /// UI treats VLM notes as unavailable — graceful, never an error.
    private func vlm(_ p: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        reply(nil, nil)
    }

    private func capabilities() -> [String: Any] {
        return [
            "ocr": true,
            "classify": model(named: "DungeonCellClassifier") != nil,
            "terrain": model(named: "TerrainClassifier") != nil,
            // iOS build: no local Ollama server, so the optional vision-LLM path
            // is off (the macOS Developer-ID build is the only one that probes it).
            "ollama": false,
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
    /// directly because "ds" is a WKScriptMessageHandlerWithReply. Identical to
    /// the macOS NativeBridge shim (the JS contract is shared). `nonisolated` so
    /// the WebViewController's webview setup can read it.
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
        vlm:          function (image, prompt){ return call({ cmd: 'vlm', image: image, prompt: prompt }); },
        capabilities: function ()             { return call({ cmd: 'capabilities' }); }
      };
    })();
    """

    // MARK: - Picker presentation (openImage sources)

    private func presentCamera(from presenter: UIViewController) {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.allowsEditing = false
        picker.delegate = self
        presenter.present(picker, animated: true)
    }

    private func presentPhotoPicker(from presenter: UIViewController) {
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 1
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        presenter.present(picker, animated: true)
    }

    private func presentImageFilesPicker(from presenter: UIViewController) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.image, .pdf], asCopy: true)
        picker.delegate = self
        picker.allowsMultipleSelection = false
        presenter.present(picker, animated: true)
    }

    /// Resolve the in-flight openImage reply: {name, dataUrl} on success, {} on
    /// cancel or load failure (graceful — the JS caller maps either to null).
    private func resolveImage(_ dataUrl: String?, name: String?, cancel: Bool) {
        let reply = pendingImageReply
        pendingImageReply = nil
        guard let reply = reply else { return }
        if let du = dataUrl, let n = name {
            reply(["name": n, "dataUrl": du], nil)
        } else {
            reply([:], nil)
        }
    }

    // MARK: - UIImagePickerControllerDelegate (camera)

    func imagePickerController(_ picker: UIImagePickerController,
                               didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true) { [weak self] in
            guard let img = info[.originalImage] as? UIImage,
                  let du = self?.pngDataURL(from: img) else {
                self?.resolveImage(nil, name: nil, cancel: false); return
            }
            self?.resolveImage(du, name: "photo.png", cancel: false)
        }
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true) { [weak self] in
            self?.resolveImage(nil, name: nil, cancel: true)
        }
    }

    // MARK: - PHPickerViewControllerDelegate (Choose Photo)

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true) { [weak self] in
            guard let self, let result = results.first else {
                self?.resolveImage(nil, name: nil, cancel: true); return
            }
            let name = result.itemProvider.suggestedName ?? "photo.png"
            // loadObject completion fires on a background queue; hop to main to
            // touch the @MainActor reply state.
            result.itemProvider.loadObject(ofClass: UIImage.self) { obj, _ in
                DispatchQueue.main.async {
                    guard let img = obj as? UIImage, let du = self.pngDataURL(from: img) else {
                        self.resolveImage(nil, name: nil, cancel: false); return
                    }
                    self.resolveImage(du, name: name, cancel: false)
                }
            }
        }
    }

    // MARK: - UIDocumentPickerDelegate (Files + openProject)

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else { resolveDocCancel(); return }
        // The image-files picker and the project picker share this callback;
        // disambiguate by which reply is currently pending.
        if let reply = pendingProjectReply {
            pendingProjectReply = nil
            if let text = readText(url: url) {
                reply(["name": url.lastPathComponent, "text": text], nil)
            } else {
                reply([:], nil)
            }
            return
        }
        if pendingImageReply != nil {
            let du = readImageDataURL(url: url)
            resolveImage(du, name: du == nil ? nil : url.lastPathComponent, cancel: false)
            return
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        resolveDocCancel()
    }

    /// Cancel resolves whichever reply is pending (project -> {}, image -> {}).
    private func resolveDocCancel() {
        if let reply = pendingProjectReply { pendingProjectReply = nil; reply([:], nil); return }
        resolveImage(nil, name: nil, cancel: true)
    }

    // MARK: - File reading

    /// Read a picked file's bytes as a normalized PNG data URL (a PDF has its
    /// first page rasterized first). Honors security-scoped access.
    private func readImageDataURL(url: URL) -> String? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        if url.pathExtension.lowercased() == "pdf" {
            return pdfFirstPagePNGDataURL(from: url)
        }
        guard let data = try? Data(contentsOf: url) else { return nil }
        return pngDataURL(from: data)
    }

    /// Read a picked project file as UTF-8 text. Honors security-scoped access.
    private func readText(url: URL) -> String? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        return try? String(contentsOf: url, encoding: .utf8)
    }

    // MARK: - Presentation helpers

    /// The controller to present pickers/sheets from: the WebViewController when
    /// set, else the key window's rootVC (connectedScenes lookup).
    private func topController() -> UIViewController? {
        if let pc = presentingController { return pc }
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        return scene?.windows.first(where: { $0.isKeyWindow })?.rootViewController
            ?? scene?.windows.first?.rootViewController
    }

    /// Anchor a popover-style controller (action sheet / share sheet) to the
    /// webview so iPad presentation doesn't crash with "no popover sourceView".
    private func configurePopover(_ vc: UIViewController) {
        guard let pop = vc.popoverPresentationController, let wv = webView else { return }
        pop.sourceView = wv
        pop.sourceRect = CGRect(x: wv.bounds.midX, y: wv.bounds.midY, width: 1, height: 1)
        pop.permittedArrowDirections = []
    }

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

    /// Decode a `data:image/...;base64,....` URL to its raw bytes.
    private func dataFromDataURL(_ durl: String) -> Data? {
        guard let comma = durl.firstIndex(of: ",") else { return nil }
        return Data(base64Encoded: String(durl[durl.index(after: comma)...]))
    }

    /// Build a CGImage from arbitrary image bytes (HEIC/TIFF/PNG/JPEG/GIF/WebP).
    private func cgImage(from data: Data) -> CGImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(src, 0, nil)
    }

    /// Wrap a CGImage as a PNG `data:` URL via UIImage (iOS has no
    /// NSBitmapImageRep, unlike the macOS NativeBridge).
    private func pngDataURL(from cg: CGImage) -> String? {
        let img = UIImage(cgImage: cg, scale: 1.0, orientation: .up)
        guard let png = img.pngData() else { return nil }
        return "data:image/png;base64," + png.base64EncodedString()
    }

    /// Normalize any decodable image to a PNG `data:` URL (HEIC/TIFF/etc -> PNG).
    private func pngDataURL(from data: Data) -> String? {
        guard let cg = cgImage(from: data) else { return nil }
        return pngDataURL(from: cg)
    }

    /// Normalize a UIImage to a PNG `data:` URL (camera / photo-picker output).
    private func pngDataURL(from image: UIImage) -> String? {
        guard let png = image.pngData() else { return nil }
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
    /// origin, so no y-flip is needed. The final CGImage is wrapped via UIImage
    /// (cross-platform code is identical through the CGContext render step).
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
        return pngDataURL(from: cg)
    }
}
