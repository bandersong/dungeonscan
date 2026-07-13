import UIKit
import WebKit

/// Full-screen WKWebView host. The iOS equivalent of the macOS AppDelegate's
/// `makeWebView` + window.contentView assignment: a WKWebView pinned edge-to-edge
/// (respecting the safe area) with the NativeBridge shim injected at document
/// start and the "ds" WKScriptMessageHandlerWithReply registered. The bridge is
/// held strongly here so it survives the webview; the bridge in turn keeps a
/// weak ref back to this controller for presenting pickers/sheets.
///
/// The webview's own scroll bounce is disabled — the digitizer UI manages its
/// own scrolling internally and a rubber-banding WKWebView would double-scroll.
final class WebViewController: UIViewController {

    private var webView: WKWebView!
    private var bridge: IOSBridge!

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let bridge = IOSBridge()
        self.bridge = bridge

        let webView = Self.makeWebView(bridge: bridge)
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
        ])
        self.webView = webView

        // The bridge presents pickers/sheets off this controller's view/window.
        bridge.presentingController = self
        bridge.webView = webView

        // The UI ships as bundled resources: Web/index.html (+ siblings). Read
        // access is granted to the Web dir so relative asset paths resolve.
        let index = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "Web")
                 ?? Bundle.main.url(forResource: "index", withExtension: "html")
        if let index = index {
            webView.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
        }
    }

    /// Build a WKWebView with the IOSBridge shim injected at document start and
    /// the "ds" WKScriptMessageHandlerWithReply registered. Because the handler
    /// is WithReply, JS `postMessage` returns the reply Promise directly.
    /// Web Inspector is enabled for bridge development. Mirrors the macOS
    /// AppDelegate.makeWebView one-for-one.
    private static func makeWebView(bridge: IOSBridge) -> WKWebView {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(source: IOSBridge.shim,
                                              injectionTime: .atDocumentStart,
                                              forMainFrameOnly: true))
        controller.addScriptMessageHandler(bridge, contentWorld: .page, name: "ds")

        let config = WKWebViewConfiguration()
        config.userContentController = controller
        // Enable Web Inspector (development). Mirrors the macOS build.
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        let webView = WKWebView(frame: .zero, configuration: config)
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        // The digitizer UI scrolls internally; suppress the webview's own bounce.
        webView.scrollView.bounces = false
        return webView
    }
}
