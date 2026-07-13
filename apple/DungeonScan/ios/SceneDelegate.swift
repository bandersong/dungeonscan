import UIKit

/// Owns the single UIWindow for a window-style UIScene. Creates the window on
/// connection, sets its rootViewController to a WebViewController, and makes it
/// key+visible. This is the UIKit scene-based equivalent of the macOS
/// AppDelegate's `applicationDidFinishLaunching` window creation — the actual
/// WKWebView lives in WebViewController.
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene,
               willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = WebViewController()
        window.makeKeyAndVisible()
        self.window = window
    }
}
