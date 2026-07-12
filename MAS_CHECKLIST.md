# DungeonScan — Mac App Store submission checklist

A concrete, ordered checklist for **Jesus** to get DungeonScan from "builds
locally" to "on the store". DungeonScan is the easy case: it's a **pure-Swift**
app (no Python/PyInstaller, no MLX, no embedded runtime), so the hard MAS
blockers that heavier apps hit don't apply here:

- ❌ No compliance-built CPython / `itms-services` auto-reject (no Python stdlib).
- ❌ No `multiprocessing` SemLock sandbox failure (no Python).
- ❌ No `allow-unsigned-executable-memory` entitlement (CoreML/Vision, not MLX) —
  a **tighter** sandbox than a model-runtime app. See
  [`apple/DungeonScan.entitlements.mas`](apple/DungeonScan.entitlements.mas).
- ✅ The one review-friction item that **does** carry over is the
  `network.client` entitlement — required by WKWebView even though the page makes
  zero outbound requests. Pre-written review note in §7.

Bundle id `io.github.bandersong.dungeonscan` · team `2Y394P797H`.

---

## 1. Apple Developer account (one-time)

- [ ] Active **Apple Developer Program** membership (individual account,
      "Jesus Triana") — team **2Y394P797H**.
- [ ] Optional but recommended: enroll in the **App Store Small Business
      Program** (15% vs 30% commission under $1M/yr) once the app record exists.
      You attest prior-year proceeds are under $1M.

## 2. Identifiers, certificates & provisioning (Apple Developer portal)

Sign in at <https://developer.apple.com/account>.

- [ ] **Certificates, Identifiers & Profiles → Identifiers → App IDs → +**
      - Platform: **macOS**
      - Explicit Bundle ID: **`io.github.bandersong.dungeonscan`**
      - Capabilities: **none** need checking. App Sandbox is applied via
        entitlements at sign time, not a portal capability. (No IAP in v1 →
        don't check In-App Purchase. No App Groups, no Push.)
- [ ] **Certificates → +**  (both are **macOS**, created from a Keychain
      Certificate Signing Request on this Mac)
      - [ ] **Apple Distribution** (the cert Xcode/the keychain may list as
            "Apple Distribution: Jesus Triana (2Y394P797H)" or, on older
            accounts, "3rd Party Mac Developer Application: …"). Used to sign
            the **.app**.
      - [ ] **3rd Party Mac Developer Installer** →
            "3rd Party Mac Developer Installer: Jesus Triana (2Y394P797H)".
            Used by `productbuild` to sign the **.pkg**.
      - Both private keys land in this Mac's login keychain.
- [ ] **Profiles → + → Mac App Store**
      - App ID: `io.github.bandersong.dungeonscan`
      - Certificate: the Apple Distribution cert above
      - Generate + **Download** →
        `~/DungeonScan/apple/DungeonScan_MAS.provisionprofile`
      - `build_mas.sh` reads its UUID and installs it where Xcode expects
        (`~/Library/MobileDevice/Provisioning Profiles/`).

If your keychain's app cert reads **"Apple Distribution: …"** instead of
"3rd Party Mac Developer Application: …", tell the script before running:
```sh
export DS_MAS_APP_CERT="Apple Distribution: Jesus Triana (2Y394P797H)"
```

## 3. App Store Connect — app record

<https://appstoreconnect.apple.com> → My Apps → **+ → New App**.

- [ ] Platforms: **macOS**
- [ ] Name: **DungeonScan** (subtitle e.g. *"Photo-to-battle-map + VTT scanner"*)
- [ ] Primary language: English
- [ ] Bundle ID: `io.github.bandersong.dungeonscan` (the App ID from §2)
- [ ] SKU: `dungeonscan-mac`  · access: Full Access
- [ ] **Primary category: Graphics & Design** · **Secondary: Utilities**
      (Graphics & Design matches `package.json`'s
      `public.app-category.graphics-design` and the tool's output; Utilities is
      where the tabletop-tool cluster browses.)
- [ ] Age rating: **4+** — answer "None" to every content question.
- [ ] Price: paid-upfront (e.g. parity with the direct price) or free — your call.
      No IAP in v1, so no StoreKit records to create.
- [ ] **Privacy policy URL** (required, 5.1.1): host one page —
      "DungeonScan processes your images entirely on your device. We do not
      collect, transmit, or store any of your data." — and paste the URL.

## 4. Privacy — "Data Not Collected" (the honest, strong label)

This is legitimate and is the strongest privacy stance in the category:
everything runs on-device; images never leave the Mac.

- [ ] App Privacy "nutrition label": **Data Collection = "Data Not Collected"**.
      Verified: Vision + CoreML run locally; WKWebView loads only bundled
      `Web/index.html` (no remote URL, no fetch/XHR to a server); no analytics,
      no telemetry, no third-party SDK.
- [ ] The `com.apple.security.network.client` entitlement exists **only** so
      WKWebView can render local, in-memory HTML (its out-of-process WebContent
      process needs it even for `loadFileURL`). It carries **no data** — state
      this in the review note (§7). A reviewer can confirm with Little Snitch /
      a packet trace.

## 5. Export compliance (the encryption question)

- [ ] `ITSAppUsesNonExemptEncryption = false` is already in
      [`apple/DungeonScan/Info.plist`](apple/DungeonScan/Info.plist). DungeonScan
      uses **no proprietary encryption** and adds none beyond standard system
      APIs, so it falls in the exempt ("uses standard encryption only") path.
      Answer the App Store Connect questionnaire accordingly. (It's a legal
      attestation — you sign it.)

## 6. Screenshots & metadata

- [ ] **Screenshots (macOS):** 1280×800 or 1440×900, light mode (dark optional).
      Suggested frames: the imported dungeon photo → rectify + grid-detect
      overlay → digitized walls/floor → exported clean battle-map PNG → the
      `.dd2vtt` open in Foundry/Roll20. Capture on a real Mac for HiDPI.
- [ ] **App description** — in your voice: photograph a hand-drawn grid dungeon,
      DungeonScan rebuilds a clean battle map + Universal VTT (Foundry/Roll20),
      fully on-device/offline.
- [ ] **Keywords (100 chars, comma-separated):**
      `dungeon,battle map,VTT,Foundry,Roll20,D&D,tabletop,map scan,grid,TTRPG`
- [ ] Support URL + (optional) marketing URL. App Review contact info.

## 7. App Review note (paste into "Notes")

> DungeonScan runs fully offline; there is no account or login. To test: open
> the app, open a photo of a hand-drawn grid dungeon, confirm the grid overlay,
> then export — a clean battle-map PNG and a Universal VTT `.dd2vtt` (open it in
> Foundry or Roll20 to verify the walls/doors). All processing (OCR via Apple
> Vision, glyph classification via a bundled CoreML model) happens on-device.
> The `com.apple.security.network.client` entitlement is required solely so
> WKWebView can render the local bundled UI (its WebContent process needs it
> even for in-bundle `loadFileURL`); the app makes no network requests and
> collects no data.

## 8. Build the store .pkg

On the Mac, **in Terminal.app** (keychain), with the profile from §2 in place:

```sh
cd ~/DungeonScan/apple
./build_mas.sh
# -> ~/DungeonScan/dist/DungeonScan-<version>-mas.pkg
```

This signs the sandboxed `.app` with the Apple Distribution cert, embeds the MAS
provisioning profile, wraps it in a `.pkg` signed with the Installer cert, and
verifies the entitlements. Run `./build_mas.sh --app` first if you want to
launch-test the signed sandboxed `.app` before packaging.

## 9. Validate + upload

Use an **App Store Connect API key** (preferred): create one at App Store
Connect → Users and Access → Keys (access: App Manager or Admin), download the
`.p8`, note the **Key ID** and **Issuer ID**. Put the `.p8` somewhere `altool`
can read (its default search path includes `~/.appstoreconnect/private_keys/`
and `./private_keys/`).

```sh
PKG="$HOME/DungeonScan/dist/DungeonScan-0.1.0-mas.pkg"   # use the actual version

# Validate (catches signing/profile/bundle problems BEFORE the slow upload)
xcrun altool --validate-app \
  -f "$PKG" -t macos \
  --apiKey  <APP_STORE_KEY_ID> \
  --apiIssuer <APP_STORE_ISSUER_ID>

# Upload
xcrun altool --upload-app \
  -f "$PKG" -t macos \
  --apiKey  <APP_STORE_KEY_ID> \
  --apiIssuer <APP_STORE_ISSUER_ID>
```

Alternative credential form (Apple ID + app-specific password — sign in at
appleid.apple.com → Sign-In and Security → App-Specific Passwords):
```sh
xcrun altool --validate-app -f "$PKG" -t macos -u <APPLE_ID> -p <APP_SPECIFIC_PW>
xcrun altool --upload-app  -f "$PKG" -t macos -u <APPLE_ID> -p <APP_SPECIFIC_PW>
```

**Or skip the CLI entirely:** drag `DungeonScan-<version>-mas.pkg` into the
**Transporter.app** and click **Deliver**. (`altool` wraps the same iTMSTransporter
Transporter uses.)

> `xcrun notarytool` is for the **Developer-ID** channel only — do **not** use it
> here. Store builds are validated by App Review, not notarization.

## 10. Submit & ship

- [ ] In App Store Connect, the uploaded build appears under the app →
      **select it** for the version.
- [ ] Add the screenshots, description, keywords, support URL, privacy label
      (§4–§6) and the review note (§7).
- [ ] Answer the export-compliance prompt (§5).
- [ ] **Add for Review.**
- [ ] On approval, release (or schedule). Watch crash/behavior reports in App
      Store Connect for the first days.

Expect 1–2 review rounds on a first submission — normal. The most likely
follow-up is a question about the `network.client` entitlement on an "offline"
app; §7's note pre-empts it.
