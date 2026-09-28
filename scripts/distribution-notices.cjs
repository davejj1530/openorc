#!/usr/bin/env node
// Checks notice evidence and built distributions without downloading or rewriting it.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "..");
const manifestFile = path.join(root, "licenses/manifest.json");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
function reviewedHash(file) {
  const expected = file.platformSha256 ? file.platformSha256[process.platform] : file.sha256;
  assert.match(expected ?? "", /^[a-f0-9]{64}$/, `${file.id}: no reviewed notice hash for ${process.platform}`);
  return expected;
}

function resolvePackage(name, importer) {
  for (const directory of createRequire(importer).resolve.paths(name) ?? []) {
    const file = path.join(directory, name, "package.json");
    if (fs.existsSync(file)) return fs.realpathSync(file);
  }
  throw new Error(`Cannot resolve ${name} from ${path.relative(root, importer)}`);
}

function installedPackages(distribution) {
  const entry = path.join(root, "apps", distribution, "package.json");
  const packages = new Map();
  const visited = new Set();
  function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const pkg = readJson(file);
    const versions = packages.get(pkg.name) ?? new Set();
    versions.add(pkg.version);
    packages.set(pkg.name, versions);
    for (const name of new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})])) {
      let dependency;
      try {
        dependency = resolvePackage(name, file);
      } catch (error) {
        if (pkg.optionalDependencies?.[name]) continue;
        throw error;
      }
      visit(dependency);
    }
  }
  visit(entry);
  // Electron is a development dependency whose downloaded runtime is shipped.
  if (distribution === "desktop") visit(resolvePackage("electron", entry));
  return packages;
}

function verifySources(distribution) {
  const manifest = readJson(manifestFile);
  assert.equal(manifest.schemaVersion, 1, "Unsupported notice manifest schema");
  for (const target of distribution ? [distribution] : ["desktop", "website"]) {
    const installed = installedPackages(target);
    for (const pkg of manifest.packages.filter((item) => item.distribution === target)) {
      const versions = [...(installed.get(pkg.name) ?? [])].sort();
      assert.deepEqual(versions, [pkg.version], `${pkg.name}: reviewed version changed; review and refresh licenses/manifest.json`);
    }
    for (const file of manifest.files.filter((item) => item[target])) {
      assert.equal(hash(fs.readFileSync(path.join(root, file.input))), reviewedHash(file), `${file.id}: source notice changed; review original bytes before updating its hash`);
      if (target === "website") {
        const publicFile = path.join(root, "apps/website/public", file.website);
        assert.equal(hash(fs.readFileSync(publicFile)), file.sha256, `${file.id}: website public notice is missing or stale`);
      }
    }
  }
  return manifest;
}

function asarReader() {
  // Reuse the packager's existing ASAR reader; no additional dependency/install.
  const desktopRequire = createRequire(path.join(root, "apps/desktop/package.json"));
  const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
  return createRequire(builderRequire.resolve("app-builder-lib"))("@electron/asar");
}

/**
 * A Windows executable names only the app's version, and the app no longer runs as Node to report its runtime. Its V8
 * snapshot, which packaging copies unchanged and every Electron build regenerates, identifies the runtime instead: when
 * it matches the installed electron package's copy, the app runs that package's version.
 */
function windowsRuntimeVersion(appPath) {
  const electronDir = path.dirname(createRequire(path.join(root, "apps/desktop/package.json")).resolve("electron/package.json"));
  const snapshot = (dir) => hash(fs.readFileSync(path.join(dir, "v8_context_snapshot.bin")));
  return snapshot(appPath) === snapshot(path.join(electronDir, "dist")) ? JSON.parse(fs.readFileSync(path.join(electronDir, "package.json"), "utf8")).version : undefined;
}

function verifyDesktop(appPath, manifest) {
  const mac = appPath.endsWith(".app");
  assert.ok(mac || process.platform === "win32", "Windows application inspection requires a Windows runner");
  const resources = path.join(appPath, mac ? "Contents/Resources" : "resources");
  const archive = path.join(resources, "app.asar");
  const asar = asarReader();
  const files = asar.listPackage(archive).map((file) => file.replaceAll("\\", "/").replace(/^\/+/, ""));
  // ASAR lookup uses the host separator; the manifest and inventory use POSIX paths.
  const read = (file) => asar.extractFile(archive, file.replaceAll("/", path.sep));
  for (const file of manifest.files.filter((item) => item.desktop)) {
    const bytes = file.desktop.asar ? read(file.desktop.asar) : fs.readFileSync(path.join(resources, file.desktop.resource));
    assert.equal(hash(bytes), reviewedHash(file), `${file.id}: packaged notice is missing or differs from its reviewed source`);
  }
  for (const pkg of manifest.packages.filter((item) => item.distribution === "desktop" && item.name !== "electron")) {
    const bundled = JSON.parse(read(`node_modules/${pkg.name}/package.json`));
    assert.equal(bundled.version, pkg.version, `${pkg.name}: packaged version differs from notice evidence`);
  }
  const electron = manifest.packages.find((item) => item.name === "electron");
  const runtimeVersion = mac
    ? fs.readFileSync(path.join(appPath, "Contents/Frameworks/Electron Framework.framework/Resources/Info.plist"), "utf8").match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
    : windowsRuntimeVersion(appPath);
  assert.equal(runtimeVersion, electron.version, "Electron binary version differs from copied runtime notices");
  for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
    assert.deepEqual(fs.readFileSync(path.join(resources, file)), fs.readFileSync(path.join(root, file)), `${file}: distribution copy differs`);
  }
  const packages = [];
  for (const file of files.filter((entry) => /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(entry))) {
    const pkg = JSON.parse(read(file));
    const prefix = path.posix.dirname(file) + "/";
    const immediate = files.filter((entry) => entry.startsWith(prefix) && !entry.slice(prefix.length).includes("/"));
    const notices = immediate.filter((entry) => /^(licen[cs]e|notice|copying)(?:[.-]|$)/i.test(path.posix.basename(entry)));
    const readme = immediate.find((entry) => /^readme(?:\.|$)/i.test(path.posix.basename(entry)));
    // A filename-only audit misses MIT texts retained in upstream READMEs.
    const readmeLicense = readme && /Permission is hereby granted[\s\S]*THE SOFTWARE IS PROVIDED/i.test(read(readme).toString());
    const supplement = manifest.files.find((entry) => entry.covers?.includes(pkg.name));
    if (supplement) {
      const primary = manifest.packages.find((entry) => entry.name === supplement.covers[0]);
      assert.equal(pkg.version, primary.version, `${pkg.name}: supplemental notice version differs`);
    }
    const unresolved = manifest.unresolved.find((entry) => entry.packages.includes(pkg.name));
    const exception = manifest.noticeExceptions?.find((entry) => entry.name === pkg.name);
    if (exception) {
      assert.equal(pkg.version, exception.version, `${pkg.name}: notice exception version differs; review again`);
      const declaration = manifest.files.find((entry) => entry.id === exception.evidence);
      assert.ok(declaration?.desktop?.resource, `${pkg.name}: notice exception requires preserved metadata`);
      const metadata = readJson(path.join(resources, declaration.desktop.resource));
      for (const key of ["name", "version", "license", "author"]) {
        assert.ok(metadata[key], `${pkg.name}: preserved metadata lacks ${key}`);
        assert.deepEqual(pkg[key], metadata[key], `${pkg.name}: packaged ${key} differs from preserved metadata`);
      }
    }
    const evidence = noticeEvidence({ project: pkg.name?.startsWith("@openorc/"), notices, readmeLicense, supplement, exception });
    packages.push({
      name: pkg.name,
      version: pkg.version,
      declaredLicense: pkg.license ?? null,
      evidence,
      files: notices,
      ...(readmeLicense ? { readme } : {}),
      ...(supplement ? { supplement: supplement.input } : {}),
      ...(unresolved ? { limitation: unresolved.reason } : {}),
      ...(exception ? { noticeException: exception.reason, declaration: exception.evidence } : {}),
    });
  }
  packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return {
    distribution: "desktop",
    scope: "File-presence inventory plus explicitly reviewed supplemental notices; not complete licensing clearance",
    packageCount: packages.length,
    unresolved: packages.filter((pkg) => pkg.evidence === "unresolved"),
    limitations: packages.filter((pkg) => pkg.limitation),
    exceptions: packages.filter((pkg) => pkg.noticeException),
    packages,
  };
}

function verifyWebsite(distPath, manifest) {
  for (const file of manifest.files.filter((item) => item.website)) {
    assert.equal(hash(fs.readFileSync(path.join(distPath, file.website))), file.sha256, `${file.id}: built website notice is missing or stale`);
  }
  return { distribution: "website", scope: "Reviewed font and provider-artwork notices in the static artifact", notices: manifest.files.filter((item) => item.website).map((item) => item.website) };
}

// electron-builder beforePack hook: reject changed versions/notice bytes before packaging.
module.exports = () => {
  verifySources("desktop");
};

if (require.main === module) {
  try {
    const [mode = "check", artifact, report] = process.argv.slice(2);
    assert.ok(["check", "desktop", "website"].includes(mode), "Usage: distribution-notices.cjs [check | desktop <absolute.app> [report.json] | website <absolute-dist> [report.json]]");
    if (mode === "check") assert.ok(!artifact || ["desktop", "website"].includes(artifact), "check accepts desktop or website as its optional scope");
    const manifest = verifySources(mode === "check" ? artifact : mode);
    if (mode === "check") console.log(`PASS notice sources, reviewed package versions, and website public copies (${manifest.files.length} inputs)`);
    else {
      assert.ok(artifact && path.isAbsolute(artifact), "Supply an absolute artifact path");
      const result = mode === "desktop" ? verifyDesktop(artifact, manifest) : verifyWebsite(artifact, manifest);
      if (report) fs.writeFileSync(report, JSON.stringify(result, null, 2) + "\n");
      console.log(`PASS ${mode} notice bytes match their reviewed sources`);
      if (result.exceptions?.length) {
        console.log(`NOTICE EXCEPTIONS (${result.exceptions.length}): ${result.exceptions.map((pkg) => `${pkg.name}@${pkg.version}: ${pkg.noticeException}`).join("; ")}`);
      }
      if (result.unresolved?.length) {
        console.log(`UNRESOLVED (${result.unresolved.length}): ${result.unresolved.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ")}`);
        process.exitCode = 2;
      }
      if (result.limitations?.length) {
        console.log(`LIMITATIONS (${result.limitations.length}): ${result.limitations.map((pkg) => `${pkg.name}@${pkg.version}: ${pkg.limitation}`).join("; ")}`);
        process.exitCode = 2;
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function noticeEvidence({ project, notices, readmeLicense, supplement, exception }) {
  if (project) return "project LICENSE";
  if (notices.length) return "license/notice files";
  if (readmeLicense) return "full license in README";
  if (supplement) return "supplemental notice";
  if (exception) return "reviewed metadata declaration";
  return "unresolved";
}
