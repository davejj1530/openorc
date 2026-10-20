/**
 * Notarizes the signed macOS release app in electron-builder's afterSign step, in place of its built-in notarization.
 * After Apple accepts the app, stapling fetches the ticket from Apple's servers, and GitHub's macOS runners sometimes
 * lose that connection; the built-in step then fails the whole build. Here a failed staple notarizes and staples again
 * after a pause, while any other failure still stops the release.
 */
const path = require("node:path");
const { createRequire } = require("node:module");

const attempts = 4;
const pauseMs = 30_000;

/** electron-builder's own copy of @electron/notarize, so the release notarizes exactly as the built-in step did. */
function loadNotarize() {
  const builder = createRequire(require.resolve("electron-builder", { paths: [__dirname] }));
  return createRequire(builder.resolve("app-builder-lib"))("@electron/notarize").notarize;
}

async function notarizeWithRetries(options, { notarize, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = console.warn }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await notarize(options);
    } catch (error) {
      if (attempt >= attempts || !/staple/i.test(String(error?.message ?? error))) throw error;
      log(`Stapling the notarization ticket failed (attempt ${attempt} of ${attempts}); notarizing again in ${pauseMs / 1000}s.`);
      await wait(pauseMs);
    }
  }
}

async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const { APPLE_API_KEY: appleApiKey, APPLE_API_KEY_ID: appleApiKeyId, APPLE_API_ISSUER: appleApiIssuer } = process.env;
  await notarizeWithRetries({ tool: "notarytool", appPath, appleApiKey, appleApiKeyId, appleApiIssuer }, { notarize: loadNotarize() });
}

module.exports = { default: afterSign, notarizeWithRetries, attempts };
