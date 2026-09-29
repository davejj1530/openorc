const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRequire } = require("node:module");
const { releaseConfig, validateReleaseSource } = require("./desktop-release.cjs");
const env = {
  RELEASE_TAG: "v0.1.0",
  OPENORC_RELEASE_REPOSITORY: "fixture/openorc",
  CSC_LINK: "fixture",
  CSC_KEY_PASSWORD: "fixture",
  MAC_SIGNING_IDENTITY: "Developer ID Application: Fixture (FIXTURE)",
  APPLE_API_KEY: "/fixture/key.p8",
  APPLE_API_KEY_ID: "fixture",
  APPLE_API_ISSUER: "fixture",
  WIN_CSC_LINK: "fixture",
  WIN_CSC_KEY_PASSWORD: "fixture",
  WINDOWS_PUBLISHER_NAME: "Fixture",
};
const input = { env, version: "0.1.0", platform: "darwin", arch: "arm64" };
test("private draft preparation preserves repository identity and visibility validation", () => {
  const source = {
    repository: "fixture/openorc",
    currentRepository: "fixture/openorc",
    tag: "v0.1.0",
    metadata: { full_name: "fixture/openorc", private: true, visibility: "private" },
  };
  assert.doesNotThrow(() => validateReleaseSource(source));
  assert.doesNotThrow(() => validateReleaseSource({ ...source, createDraft: true }));
  assert.doesNotThrow(() => validateReleaseSource({ ...source, createDraft: true, metadata: { ...source.metadata, private: false, visibility: "public" } }));
  assert.throws(() => validateReleaseSource({ ...source, currentRepository: "fixture/development" }), /repository named/);
  assert.throws(() => validateReleaseSource({ ...source, metadata: { ...source.metadata, full_name: "another/repo" } }), /does not match/);
  assert.throws(() => validateReleaseSource({ ...source, metadata: { ...source.metadata, visibility: "internal" } }), /visibility/);
  assert.throws(() => validateReleaseSource({ ...source, repository: "https://github.com/fixture/openorc" }), /owner\/repository/);
  assert.doesNotThrow(() => validateReleaseSource({ ...source, tag: "v0.1.0-beta.1" }));
  for (const tag of ["v0.0.0", "v0.0.0-beta.1", "v0.1.0-beta", "v0.1.0-beta.01", "main"]) assert.throws(() => validateReleaseSource({ ...source, tag }), /tag/);
});
test("release configurations satisfy the installed electron-builder schema", async () => {
  const desktop = createRequire(path.resolve(__dirname, "../apps/desktop/package.json"));
  const builder = createRequire(desktop.resolve("electron-builder"));
  const { validateConfiguration } = builder("app-builder-lib/out/util/config/config");
  for (const platform of ["darwin", "win32", "linux"]) await validateConfiguration(releaseConfig({ ...input, platform, arch: "x64" }), { isEnabled: false });
  await validateConfiguration(
    releaseConfig({
      platform: "win32",
      arch: "x64",
      version: "0.1.0-beta.1",
      env: {
        RELEASE_TAG: "v0.1.0-beta.1",
        OPENORC_RELEASE_REPOSITORY: env.OPENORC_RELEASE_REPOSITORY,
        OPENORC_UNSIGNED_WINDOWS_BETA: "0.1.0-beta.1",
      },
    }),
    { isEnabled: false },
  );
});
test("native release artifacts include update metadata, signatures, and separate architecture channels", () => {
  const mac = releaseConfig(input);
  const intel = releaseConfig({ ...input, arch: "x64" });
  const win = releaseConfig({ ...input, platform: "win32", arch: "x64" });
  assert.deepEqual(mac.mac.target, ["dmg", "zip"]);
  assert.equal(mac.mac.notarize, true);
  assert.equal(mac.mac.identity, "Fixture (FIXTURE)");
  assert.equal(mac.forceCodeSigning, true);
  assert.equal(mac.publish[0].channel, "latest-arm64");
  assert.equal(intel.publish[0].channel, "latest-x64");
  assert.deepEqual(win.win.target, ["nsis"]);
  assert.equal(win.nsis.deleteAppDataOnUninstall, false);
  assert.equal(win.win.signtoolOptions.publisherName, "Fixture");
  assert.ok(!JSON.stringify(mac).includes("key.p8"), "signing secrets must not become packaged configuration");
});
test("Linux x64 releases build unsigned AppImage, deb and rpm installers without signing credentials", () => {
  const linux = releaseConfig({ version: "0.1.0", platform: "linux", arch: "x64", env: { RELEASE_TAG: env.RELEASE_TAG, OPENORC_RELEASE_REPOSITORY: env.OPENORC_RELEASE_REPOSITORY } });
  assert.deepEqual(linux.linux.target, ["AppImage", "deb", "rpm"]);
  assert.equal(linux.forceCodeSigning, false);
  assert.equal(linux.publish[0].channel, "latest-x64");
  assert.equal(linux.mac, undefined);
  assert.equal(linux.win, undefined);
});
test("rejects missing credentials, placeholder versions, unsafe repositories and mismatched tags", () => {
  for (const key of ["RELEASE_TAG", "OPENORC_RELEASE_REPOSITORY", "CSC_LINK", "CSC_KEY_PASSWORD", "MAC_SIGNING_IDENTITY", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) {
    assert.throws(() => releaseConfig({ ...input, env: { ...env, [key]: "" } }), new RegExp(key));
  }
  for (const key of ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD", "WINDOWS_PUBLISHER_NAME"]) {
    assert.throws(() => releaseConfig({ ...input, platform: "win32", arch: "x64", env: { ...env, [key]: "" } }), new RegExp(key));
  }
  for (const version of ["0.0.0", "0.0.0-beta.1", "0.1.0-rc.1", "01.1.0", "bad"]) assert.throws(() => releaseConfig({ ...input, version }), /desktop version/);
  assert.throws(() => releaseConfig({ ...input, version: "0.2.0" }), /must match/);
  assert.throws(() => releaseConfig({ ...input, env: { ...env, OPENORC_RELEASE_REPOSITORY: "https://token@github.com/owner/repo" } }), /owner\/repository/);
  assert.throws(() => releaseConfig({ ...input, env: { ...env, MAC_SIGNING_IDENTITY: "-" } }), /Developer ID/);
  assert.throws(() => releaseConfig({ ...input, platform: "linux" }), /native macOS/);
  assert.throws(() => releaseConfig({ ...input, platform: "freebsd", arch: "x64" }), /native macOS/);
});

test("unsigned Windows beta requires an exact-version opt-in and cannot weaken macOS or stable signing", () => {
  const version = "0.1.0-beta.1";
  const betaEnv = { RELEASE_TAG: `v${version}`, OPENORC_RELEASE_REPOSITORY: env.OPENORC_RELEASE_REPOSITORY, OPENORC_UNSIGNED_WINDOWS_BETA: version };
  const beta = { version, env: betaEnv, platform: "win32", arch: "x64" };
  const config = releaseConfig(beta);
  assert.equal(config.forceCodeSigning, false);
  assert.equal(config.win.signExecutable, false);
  assert.equal(config.win.signAndEditExecutable, undefined);
  assert.equal(config.win.verifyUpdateCodeSignature, undefined);
  assert.equal(config.publish[0].releaseType, "prerelease");
  assert.match(config.artifactName, /-unsigned/);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.throws(() => releaseConfig({ ...beta, env: { ...betaEnv, OPENORC_UNSIGNED_WINDOWS_BETA: "" } }), /WIN_CSC_LINK/);
  assert.throws(() => releaseConfig({ ...beta, env: { ...betaEnv, OPENORC_UNSIGNED_WINDOWS_BETA: "0.1.0-beta.2" } }), /exact beta version/);
  assert.throws(() => releaseConfig({ ...input, platform: "win32", arch: "x64", env: { ...env, OPENORC_UNSIGNED_WINDOWS_BETA: "0.1.0" } }), /exact beta version/);
  assert.throws(() => releaseConfig({ ...beta, platform: "darwin" }), /CSC_LINK/);
  const mac = releaseConfig({ ...beta, platform: "darwin", env: { ...env, ...betaEnv } });
  assert.equal(mac.forceCodeSigning, true);
  assert.equal(mac.mac.notarize, true);
});
