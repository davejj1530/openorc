const path = require("node:path");

const releaseVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;
const validVersion = (version) => releaseVersion.test(version) && !version.startsWith("0.0.0");

/** Drafts and build artifacts may stay private; installed update feeds require public releases. */
function validateReleaseSource({ repository, currentRepository, tag, metadata }) {
  if (!repository || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)) throw Error("RELEASE_REPOSITORY must be owner/repository");
  if (repository.toLowerCase() !== currentRepository?.toLowerCase()) throw Error("Run this workflow in the repository named by RELEASE_REPOSITORY");
  if (!tag?.startsWith("v") || !validVersion(tag.slice(1))) throw Error("Use a non-zero vX.Y.Z or vX.Y.Z-beta.N tag");
  if (metadata?.full_name?.toLowerCase() !== repository.toLowerCase()) throw Error("Repository metadata does not match the release destination");
  const isPublic = metadata.private === false && metadata.visibility === "public";
  const isPrivate = metadata.private === true && metadata.visibility === "private";
  if (!isPublic && !isPrivate) throw Error("Unsupported repository visibility");
}

/** Release inputs are deliberately separate from the unsigned local packaging configuration. */
function releaseConfig({ env = process.env, platform = process.platform, arch = process.arch, version = require("../apps/desktop/package.json").version } = {}) {
  const required = (key) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Release build requires ${key}`);
    return value;
  };
  if (!validVersion(version)) throw new Error("Set a non-zero desktop version (X.Y.Z or X.Y.Z-beta.N) before building a release");
  if (required("RELEASE_TAG") !== `v${version}`) throw new Error("RELEASE_TAG must match the desktop package version");
  const unsignedBetaVersion = env.OPENORC_UNSIGNED_WINDOWS_BETA?.trim();
  if (unsignedBetaVersion && (unsignedBetaVersion !== version || !version.includes("-beta."))) throw new Error("OPENORC_UNSIGNED_WINDOWS_BETA must match this exact beta version");
  const repository = required("OPENORC_RELEASE_REPOSITORY");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)) throw new Error("OPENORC_RELEASE_REPOSITORY must be owner/repository");
  if (!["darwin", "win32", "linux"].includes(platform) || !["arm64", "x64"].includes(arch) || (platform !== "darwin" && arch !== "x64"))
    throw new Error("Release builds support native macOS arm64/x64, Windows x64 and Linux x64 runners");
  const [owner, repo] = repository.split("/");
  const config = {
    extends: path.resolve(__dirname, "../apps/desktop/electron-builder.yml"),
    forceCodeSigning: true,
    artifactName: "OpenOrc-${version}-${os}-${arch}.${ext}",
    electronUpdaterCompatibility: ">=2.16",
    generateUpdatesFilesForAllChannels: false,
    // Each native build owns its metadata; parallel macOS builds must never overwrite one another's YAML.
    publish: [{ provider: "github", owner, repo, channel: `latest-${arch}`, releaseType: version.includes("-beta.") ? "prerelease" : "release", vPrefixedTagName: true }],
  };
  if (platform === "darwin") {
    required("CSC_LINK");
    required("CSC_KEY_PASSWORD");
    required("APPLE_API_KEY");
    required("APPLE_API_KEY_ID");
    required("APPLE_API_ISSUER");
    const identity = required("MAC_SIGNING_IDENTITY");
    const certificateName = identity.match(/^Developer ID Application:\s*(\S.*)$/)?.[1];
    if (!certificateName) throw new Error("MAC_SIGNING_IDENTITY must name a Developer ID Application certificate");
    config.mac = {
      target: ["dmg", "zip"],
      // electron-builder chooses Developer ID Application itself and rejects a repeated prefix.
      identity: certificateName,
      hardenedRuntime: true,
      notarize: true,
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.plist",
    };
  } else if (platform === "linux") {
    // Linux packages carry no code signature; the draft's SHA256SUMS.txt covers them. Installed builds do not update
    // themselves, but the release still records their metadata beside the other platforms'.
    config.forceCodeSigning = false;
    config.linux = { target: ["AppImage", "deb", "rpm"] };
  } else {
    if (unsignedBetaVersion) {
      config.forceCodeSigning = false;
      config.artifactName = "OpenOrc-${version}-${os}-${arch}-unsigned.${ext}";
      // Skip only signing; preserve the executable's icon/version resources.
      config.win = { target: ["nsis"], signExecutable: false };
    } else {
      required("WIN_CSC_LINK");
      required("WIN_CSC_KEY_PASSWORD");
      config.win = { target: ["nsis"], signtoolOptions: { publisherName: required("WINDOWS_PUBLISHER_NAME") } };
    }
    config.nsis = { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false };
  }
  return config;
}

module.exports = { releaseConfig, validateReleaseSource };
if (require.main === module) {
  releaseConfig();
  console.log("Desktop release inputs validated.");
}
