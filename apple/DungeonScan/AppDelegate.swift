import AppKit
import Sparkle
import WebKit

/// Owns DungeonScan's single main window + WKWebView and wires the NativeBridge.
/// AppKit equivalent of ScrubBuddy's SwiftUI WebView host: a titled ~1200x820
/// NSWindow whose contentView is a WKWebView that fills it.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var bridge: NativeBridge?
    private var webView: WKWebView?
    private var updater: SPUStandardUpdaterController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Sparkle auto-updater (Developer ID build). Starts the updater, which
        // checks the appcast on its own schedule; the menu adds Check for Updates…
        updater = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        setupMainMenu()

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

    /// Build the app + Edit menus. "Check for Updates…" drives Sparkle; the Edit
    /// menu gives the WebView's text fields standard copy/paste/undo shortcuts.
    private func setupMainMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "About DungeonScan", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        let check = NSMenuItem(title: "Check for Updates…", action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)), keyEquivalent: "")
        check.target = updater
        appMenu.addItem(check)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide DungeonScan", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = NSMenuItem(title: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit DungeonScan", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editItem.submenu = editMenu
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(redo)
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        NSApp.mainMenu = mainMenu
    }

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
