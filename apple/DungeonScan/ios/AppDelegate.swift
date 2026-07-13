import UIKit

/// UIApplicationDelegate for the iOS shell. Scene-based: the window itself is
/// created in SceneDelegate (one UIWindow per UIScene), so this delegate only
/// supplies the scene manifest hook — it returns a "Default" configuration whose
/// delegate class is SceneDelegate (named in Info.plist's scene manifest).
///
/// Mirrors the macOS AppDelegate's role (own the bridge + webview) but defers
/// the view hierarchy to the UIKit scene/storyboard-less lifecycle. NO Sparkle
/// (macOS-only), NO menu bar. @main is the single program entry.
@main
final class AppDelegate: NSObject, UIApplicationDelegate {

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        true
    }

    // MARK: - Scene manifest

    /// Return the default scene configuration. Its name ("Default") and delegate
    /// class (SceneDelegate) match the UIApplicationSceneManifest in Info.plist.
    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default", sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
