/**
 * Desktop release inputs, versions and notes. The release workflows run:
 *   node scripts/desktop-release.cjs next              prints tag=vX.Y.Z when HEAD has unreleased changes for users
 *   node scripts/desktop-release.cjs check <tag>       fails unless the tag is newer than every other release
 *   node scripts/desktop-release.cjs prepare           writes RELEASE_TAG's version into the desktop package, then checks the build inputs
 *   node scripts/desktop-release.cjs notes <tag> [--unsigned-windows]   prints the tag's release notes
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
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

/** Releases take their version from the tag, so version bumps are never committed. */
function withVersion(packageJson, version) {
  return packageJson.replace(/("version":\s*)"[^"]*"/, `$1"${version}"`);
}

// Commit types that never change what users get.
const internalTypes = new Set(["build", "chore", "ci", "docs", "refactor", "style", "test"]);

function parseVersion(version) {
  const match = releaseVersion.exec(version);
  if (!match) throw new Error(`Not a release version: ${version}`);
  const [major, minor, patch, beta] = match.slice(1).map((part) => (part === undefined ? null : Number(part)));
  return { major, minor, patch, beta };
}

/** Semantic order: a beta comes before its stable release. */
function compareVersions(a, b) {
  const [left, right] = [parseVersion(a), parseVersion(b)];
  for (const part of ["major", "minor", "patch"]) if (left[part] !== right[part]) return left[part] - right[part];
  if (left.beta === right.beta) return 0;
  if (left.beta === null) return 1;
  if (right.beta === null) return -1;
  return left.beta - right.beta;
}

/** The next beta, or the next patch after a stable release. */
function bumpVersion(version) {
  const { major, minor, patch, beta } = parseVersion(version);
  return beta === null ? `${major}.${minor}.${patch + 1}` : `${major}.${minor}.${patch}-beta.${beta + 1}`;
}

/** The desktop package names the release line: it ships once as written, then releases count up from the newest one. */
function nextVersion(packageVersion, released) {
  const newest = released.toSorted(compareVersions).at(-1);
  if (!newest || compareVersions(packageVersion, newest) > 0) return packageVersion;
  return bumpVersion(newest);
}

/** A commit subject as a release note line, without its type or pull request number. */
function noteLine(text) {
  const line = text.replace(/\s*\(#\d+\)$/, "").trim();
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** Changes users get, from commit subjects: features first, then fixes. Internal commits are left out. */
function releaseChanges(subjects) {
  const features = new Map();
  const fixes = new Map();
  for (const subject of subjects) {
    const conventional = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/.exec(subject.trim());
    const type = conventional?.[1]?.toLowerCase();
    if (type && internalTypes.has(type)) continue;
    const line = noteLine(conventional?.[2] ?? subject);
    const list = type === "fix" || type === "perf" || type === "revert" ? fixes : features;
    if (line && !list.has(line.toLowerCase())) list.set(line.toLowerCase(), line);
  }
  return { features: [...features.values()], fixes: [...fixes.values()] };
}

/** Release notes: highlights for the website changelog, then fixes and install notes for GitHub. */
function releaseNotes({ features, fixes, unsignedWindows }) {
  const bullets = (lines) => lines.map((line) => `- ${line}`);
  const lines = ["## Highlights", "", ...bullets(features.length ? features : fixes)];
  if (features.length && fixes.length) lines.push("", "## Fixes", "", ...bullets(fixes));
  lines.push(
    "",
    "## Install notes",
    "",
    "macOS: Developer ID signed and notarized applications in DMG/ZIP downloads.",
    unsignedWindows
      ? "Windows x64: unsigned beta. Windows may warn about the unrecognized app; some security policies may prevent installation. Download only from the official release."
      : "Windows x64: signed NSIS installer.",
    "Linux x64: rpm for Fedora and openSUSE, deb for Debian and Ubuntu, and an AppImage for other distributions. Linux packages are not code-signed; check them against SHA256SUMS.txt. Linux installs do not update themselves yet: install each new version from its release.",
    "",
    "On macOS and Windows, use Check for updates in OpenOrc for newer stable and beta releases. Downloading and restarting to install require your confirmation. Versions through 0.1.0-beta.4 need a one-time manual install to receive beta updates.",
    "",
    "SHA256SUMS.txt covers the attached installers, ZIPs, blockmaps, and update metadata.",
  );
  return `${lines.join("\n")}\n`;
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const isReleaseTag = (tag) => tag.startsWith("v") && releaseVersion.test(tag.slice(1));
const releaseTags = () => git("tag", "--list", "v*").split("\n").filter(isReleaseTag);

/** The newest release tag at or before a commit, or null before the first release. */
function previousRelease(ref) {
  try {
    return git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", ref);
  } catch {
    return null;
  }
}

function changesUntil(ref) {
  const previous = previousRelease(`${ref}^`);
  const subjects = git("log", "--no-merges", "--reverse", "--format=%s", previous ? `${previous}..${ref}` : ref);
  return releaseChanges(subjects.split("\n").filter(Boolean));
}

function main([command, tag, ...options]) {
  if (command === "next") {
    if (git("tag", "--points-at", "HEAD").split("\n").some(isReleaseTag)) return console.error("This commit is already released.");
    const changes = changesUntil("HEAD");
    if (!changes.features.length && !changes.fixes.length) return console.error("No changes for users since the last release.");
    const version = nextVersion(
      require("../apps/desktop/package.json").version,
      releaseTags().map((release) => release.slice(1)),
    );
    return console.log(`tag=v${version}`);
  }
  if (command === "prepare") {
    const releaseTag = process.env.RELEASE_TAG?.trim() ?? "";
    if (!isReleaseTag(releaseTag) || !validVersion(releaseTag.slice(1))) throw new Error("RELEASE_TAG must be a non-zero vX.Y.Z or vX.Y.Z-beta.N tag");
    const file = path.resolve(__dirname, "../apps/desktop/package.json");
    fs.writeFileSync(file, withVersion(fs.readFileSync(file, "utf8"), releaseTag.slice(1)));
    releaseConfig();
    return console.log(`Desktop release inputs validated for ${releaseTag}.`);
  }
  if (!tag || !isReleaseTag(tag)) throw new Error("Pass a vX.Y.Z or vX.Y.Z-beta.N release tag.");
  if (command === "check") {
    const newer = releaseTags().find((release) => release !== tag && compareVersions(release.slice(1), tag.slice(1)) >= 0);
    if (newer) throw new Error(`${tag} must be newer than every release; ${newer} exists. Installed apps never downgrade.`);
    return;
  }
  if (command === "notes") return process.stdout.write(releaseNotes({ ...changesUntil(tag), unsignedWindows: options.includes("--unsigned-windows") }));
  throw new Error("Use next, check <tag>, prepare, or notes <tag>.");
}

module.exports = { compareVersions, nextVersion, releaseChanges, releaseConfig, releaseNotes, validateReleaseSource, withVersion };
if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
