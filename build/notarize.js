// electron-builder afterSign hook: notarize + staple the signed .app before it
// gets packaged into the DMG. Only runs when NOTARIZE=1, so ordinary/unsigned
// builds (e.g. on a machine with no Developer ID) are unaffected.
// Credentials come from the `mapsmith-notary` keychain profile — no secrets here.
const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function notarizeHook(context) {
  if (process.env.NOTARIZE !== '1') return;
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  const { notarize } = require('@electron/notarize');
  console.log(`\n▸ Notarizing ${appPath} (this can take a few minutes)…`);
  await notarize({
    tool: 'notarytool',
    appPath,
    keychainProfile: 'mapsmith-notary'
  });
  console.log('▸ Stapling ticket to the app…');
  execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });
  console.log('▸ Notarization complete.\n');
};
