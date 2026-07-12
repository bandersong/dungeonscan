import AppKit

// Bootstrap a pure-AppKit DungeonScan: NSApplication.shared + AppDelegate, then
// run the event loop. (The SwiftUI entry point in ScrubBuddy is replaced by this
// explicit AppKit bootstrap so the whole shell is NSWindow + WKWebView.)
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
