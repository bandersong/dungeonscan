import AppKit
import WebKit

/// Owns DungeonScan's single main window + WKWebView and wires the NativeBridge.
/// AppKit equivalent of ScrubBuddy's SwiftUI WebView host: a titled ~1200x820
/// NSWindow whose contentView is a WKWebView that fills it.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var bridge: NativeBridge?
    private var webView: WKWebView?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let bridge = NativeBridge()
        self.bridge = bridge

        let style: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable]
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 820),
                              styleMask: style,
                              backing: .buffered,
                              defer: false)
        window.title = "DungeonScan"
        window.center()
        window.minSize = NSSize(width: 640, height: 420)

        let webView = Self.makeWebView(bridge: bridge)
        window.contentView = webView
        self.webView = webView
        self.window = window

        // The UI ships as bundled resources: Web/index.html (+ siblings). Read
        // access is granted to the Web dir so relative asset paths resolve.
        let index = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "Web")
                 ?? Bundle.main.url(forResource: "index", withExtension: "html")
        if let index = index {
            webView.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
        }

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// Build a WKWebView with the NativeBridge shim injected at document start
    /// and the "ds" WKScriptMessageHandlerWithReply registered. Because the
    /// handler is WithReply, JS `postMessage` returns the reply Promise directly.
    /// Web Inspector is enabled for bridge development.
    private static func makeWebView(bridge: NativeBridge) -> WKWebView {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(source: NativeBridge.shim,
                                              injectionTime: .atDocumentStart,
                                              forMainFrameOnly: true))
        controller.addScriptMessageHandler(bridge, contentWorld: .page, name: "ds")

        let config = WKWebViewConfiguration()
        config.userContentController = controller
        // Enable Web Inspector (development). Mirrors ScrubBuddy's WebView.build.
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        let webView = WKWebView(frame: .zero, configuration: config)
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        return webView
    }
}
