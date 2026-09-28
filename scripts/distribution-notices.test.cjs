const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openorc-notice-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, value) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  };
  const notice = "Synthetic notice fixture.\n";
  write("scripts/distribution-notices.cjs", fs.readFileSync(path.join(__dirname, "distribution-notices.cjs"), "utf8"));
  write("apps/website/package.json", { name: "test-site", version: "1.0.0", dependencies: { "fixture-font": "1.0.0" } });
  write("apps/website/node_modules/fixture-font/package.json", { name: "fixture-font", version: "1.0.0" });
  write("licenses/fixture.txt", notice);
  write("apps/website/public/licenses/fixture.txt", notice);
  write("dist/licenses/fixture.txt", notice);
  write("licenses/manifest.json", {
    schemaVersion: 1,
    packages: [{ name: "fixture-font", version: "1.0.0", distribution: "website" }],
    files: [{ id: "fixture-font", input: "licenses/fixture.txt", sha256: createHash("sha256").update(notice).digest("hex"), website: "licenses/fixture.txt" }],
    unresolved: [],
  });
  const run = (...args) => spawnSync(process.execPath, [path.join(root, "scripts/distribution-notices.cjs"), ...args], { encoding: "utf8", timeout: 10_000 });
  return { root, write, run };
}

test("matching source, package version, public copy and built artifact pass", (t) => {
  const { root, run } = fixture(t);
  assert.equal(run("check", "website").status, 0);
  assert.equal(run("website", path.join(root, "dist")).status, 0);
});

test("Git checkout uses LF for source and preserves reviewed notice bytes with core.autocrlf enabled", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openorc-notice-checkout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.resolve(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "licenses/manifest.json"), "utf8"));
  const files = [
    ...new Set([
      "LICENSE",
      "NOTICE",
      "THIRD_PARTY_NOTICES.md",
      ...manifest.files.filter((file) => file.input.startsWith("licenses/")).map((file) => file.input),
      ...manifest.files.filter((file) => file.website).map((file) => `apps/website/public/${file.website}`),
    ]),
  ];
  const original = new Map(files.map((file) => [file, fs.readFileSync(path.join(source, file))]));
  // CRLF notices must stay byte-identical even with the repository-wide LF rule.
  for (const file of ["licenses/checkout-crlf.txt", "apps/website/public/licenses/checkout-crlf.txt"]) original.set(file, Buffer.from("Reviewed upstream notice.\r\n"));
  for (const [file, bytes] of original) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  const control = path.join(root, "checkout-control.txt");
  fs.writeFileSync(control, "Source files must use LF.\n");
  const emptyConfig = path.join(root, "empty.gitconfig");
  fs.writeFileSync(emptyConfig, "");
  const git = (...args) => {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig },
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  };
  git("init", "--quiet");
  // Prove the fixture converts to CRLF before applying the real checkout policy.
  git("-c", "core.autocrlf=false", "add", "--", "checkout-control.txt");
  fs.unlinkSync(control);
  git("-c", "core.autocrlf=true", "checkout-index", "--force", "--", "checkout-control.txt");
  assert.equal(fs.readFileSync(control, "utf8"), "Source files must use LF.\r\n");

  fs.copyFileSync(path.join(source, ".gitattributes"), path.join(root, ".gitattributes"));
  git("-c", "core.autocrlf=false", "add", "--", ".gitattributes", "checkout-control.txt", ...original.keys());
  for (const file of ["checkout-control.txt", ...original.keys()]) fs.unlinkSync(path.join(root, file));
  git("-c", "core.autocrlf=true", "checkout-index", "--all", "--force");
  assert.equal(fs.readFileSync(control, "utf8"), "Source files must use LF.\n");
  for (const [file, bytes] of original) assert.ok(fs.readFileSync(path.join(root, file)).equals(bytes), `${file} changed during checkout`);
});

test("modified upstream text requires review instead of silently refreshing its hash", (t) => {
  const { write, run } = fixture(t);
  write("licenses/fixture.txt", "Modified fixture.\n");
  const result = run("check", "website");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /source notice changed/);
});

test("a dependency upgrade fails while its notice evidence still names the old version", (t) => {
  const { write, run } = fixture(t);
  write("apps/website/node_modules/fixture-font/package.json", { name: "fixture-font", version: "2.0.0" });
  const result = run("check", "website");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /reviewed version changed/);
});

test("missing public copies are caught before the website build", (t) => {
  const { root, run } = fixture(t);
  fs.unlinkSync(path.join(root, "apps/website/public/licenses/fixture.txt"));
  const result = run("check", "website");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
});

test("correct sources do not hide a stale notice in a built artifact", (t) => {
  const { root, write, run } = fixture(t);
  write("dist/licenses/fixture.txt", "Stale built copy.\n");
  assert.equal(run("check", "website").status, 0);
  const result = run("website", path.join(root, "dist"));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /built website notice is missing or stale/);
});

async function desktopFixture(t) {
  const { root, write, run } = fixture(t);
  const { createRequire } = require("node:module");
  const desktopRequire = createRequire(path.resolve(__dirname, "../apps/desktop/package.json"));
  const builderEntry = desktopRequire.resolve("electron-builder");
  const builderRequire = createRequire(builderEntry);
  const asar = createRequire(builderRequire.resolve("app-builder-lib"))("@electron/asar");
  const packageDir = path.dirname(builderRequire.resolve("electron-builder/package.json"));
  fs.mkdirSync(path.join(root, "apps/desktop/node_modules"), { recursive: true });
  fs.symlinkSync(packageDir, path.join(root, "apps/desktop/node_modules/electron-builder"), "junction");
  write("apps/desktop/package.json", { name: "fixture-app", version: "1.0.0", dependencies: { "fixture-native": "1.0.0" } });
  write("apps/desktop/node_modules/fixture-native/package.json", { name: "fixture-native", version: "1.0.0" });
  write("apps/desktop/node_modules/electron/package.json", { name: "electron", version: "1.0.0" });
  const app = path.join(root, "Fixture.app");
  const resources = "Fixture.app/Contents/Resources";
  const notice = "Synthetic native package notice.\n";
  write("licenses/native.txt", notice);
  write(`${resources}/licenses/native.txt`, notice);
  for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
    write(name, "Synthetic project notice.\n");
    write(`${resources}/${name}`, "Synthetic project notice.\n");
  }
  write("Fixture.app/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist", "<key>CFBundleVersion</key><string>1.0.0</string>");
  write("archive/node_modules/fixture-native/package.json", { name: "fixture-native", version: "1.0.0", license: "MIT" });
  await asar.createPackage(path.join(root, "archive"), path.join(root, resources, "app.asar"));
  const manifest = {
    schemaVersion: 1,
    packages: [
      { name: "fixture-native", version: "1.0.0", distribution: "desktop" },
      { name: "electron", version: "1.0.0", distribution: "desktop" },
    ],
    files: [
      { id: "fixture-native", input: "licenses/native.txt", sha256: createHash("sha256").update(notice).digest("hex"), desktop: { resource: "licenses/native.txt" }, covers: ["fixture-native"] },
    ],
    unresolved: [{ packages: ["fixture-native"], reason: "The exact compiled dependency inventory is unverified." }],
  };
  write("licenses/manifest.json", manifest);
  return { root, write, run, app, resources, manifest, asar, builderRequire, createRequire };
}

test("platform-specific notices require the exact native source and packaged bytes", async (t) => {
  const { write, run, app, resources, manifest } = await desktopFixture(t);
  const native = "Synthetic native package notice.\nAdditional platform component.\r\n";
  const nativeHash = createHash("sha256").update(native).digest("hex");
  const reviewed = { ...manifest, unresolved: [], files: manifest.files.map((file) => ({ ...file, platformSha256: { [process.platform]: nativeHash } })) };
  write("licenses/manifest.json", reviewed);
  write("licenses/native.txt", native);
  write(`${resources}/licenses/native.txt`, native);
  assert.equal(run("check", "desktop").status, 0);
  const packaged = run("desktop", app);
  assert.equal(packaged.status, 0, packaged.stderr || packaged.stdout);
  write("licenses/native.txt", "Synthetic native package notice.\n");
  assert.equal(run("check", "desktop").status, 1, "the default platform hash must not also be accepted");
  write("licenses/native.txt", native);
  write(`${resources}/licenses/native.txt`, "Synthetic native package notice.\n");
  assert.equal(run("desktop", app).status, 1, "a stale packaged platform notice must fail");
  write("licenses/manifest.json", { ...reviewed, files: reviewed.files.map((file) => ({ ...file, platformSha256: {} })) });
  assert.equal(run("check", "desktop").status, 1, "unreviewed platforms must fail");
});

test("a preserved package notice does not clear a recorded native-composition limitation", async (t) => {
  const { root, write, run, app, resources, manifest, asar, builderRequire, createRequire } = await desktopFixture(t);
  // Exercise the installed ASAR reader's Windows path rules on every CI host.
  const vm = require("node:vm");
  const asarRequire = createRequire(createRequire(builderRequire.resolve("app-builder-lib")).resolve("@electron/asar"));
  const filesystemPath = asarRequire.resolve("./filesystem.js");
  const windowsModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filesystemPath, "utf8"), {
    exports: windowsModule.exports,
    module: windowsModule,
    require: (name) => (name === "path" ? path.win32 : asarRequire(name)),
    process,
    Buffer,
  });
  const windowsArchive = new windowsModule.exports.Filesystem("C:\\fixture");
  const archivePath = path.join(root, resources, "app.asar");
  windowsArchive.header = asar.getRawHeader(archivePath).header;
  const fixtureAsar = {
    listPackage: () => windowsArchive.listFiles(),
    extractFile: (archive, name) => {
      windowsArchive.getFile(name);
      return asar.extractFile(archive, name.split("\\").join(path.sep));
    },
  };
  const checker = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "distribution-notices.cjs"), "utf8") + "\nasarReader = () => fixtureAsar; module.exports.inspect = verifyDesktop;", {
    module: checker,
    require: (name) => (name === "node:path" ? { ...path, sep: "\\" } : require(name)),
    __dirname: path.join(root, "scripts"),
    fixtureAsar,
    process,
  });
  const windowsReport = checker.exports.inspect(app, manifest);
  assert.equal(windowsReport.packageCount, 1);
  assert.equal(windowsReport.limitations[0].name, "fixture-native");
  const report = path.join(root, "report.json");
  const result = run("desktop", app, report);
  assert.equal(result.status, 2, result.stderr || result.stdout);
  const inspected = JSON.parse(fs.readFileSync(report, "utf8"));
  assert.equal(inspected.unresolved.length, 0);
  assert.equal(inspected.limitations[0].name, "fixture-native");
  assert.equal(inspected.limitations[0].evidence, "supplemental notice");
  assert.match(result.stdout, /LIMITATIONS/);

  write("licenses/manifest.json", { ...manifest, unresolved: [] });
  assert.equal(run("desktop", app).status, 0);
});

test("a metadata exception is visible, version-bound, and does not waive other missing notices", async (t) => {
  const { root, write, run, app, resources, manifest, asar } = await desktopFixture(t);
  const metadata = { name: "fixture-native", version: "1.0.0", license: "MIT", author: "Fixture Author" };
  const declaration = JSON.stringify(metadata);
  write("licenses/declaration.json", declaration);
  write(`${resources}/licenses/declaration.json`, declaration);
  const reviewed = {
    ...manifest,
    files: [{ id: "declaration", input: "licenses/declaration.json", sha256: createHash("sha256").update(declaration).digest("hex"), desktop: { resource: "licenses/declaration.json" } }],
    unresolved: [],
    noticeExceptions: [{ name: "fixture-native", version: "1.0.0", evidence: "declaration", reason: "Published metadata retained; upstream notice omitted." }],
  };
  const archive = path.join(root, resources, "app.asar");
  const pack = async (pkg = metadata) => {
    write("archive/node_modules/fixture-native/package.json", pkg);
    await asar.createPackage(path.join(root, "archive"), archive);
  };
  const report = path.join(root, "report.json");
  write("licenses/manifest.json", reviewed);
  await pack();
  const accepted = run("desktop", app, report);
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  assert.match(accepted.stdout, /NOTICE EXCEPTIONS.*fixture-native@1\.0\.0/);
  const inspected = JSON.parse(fs.readFileSync(report, "utf8"));
  assert.equal(inspected.unresolved.length, 0);
  assert.equal(inspected.exceptions[0].evidence, "reviewed metadata declaration");
  assert.equal(inspected.exceptions[0].noticeException, reviewed.noticeExceptions[0].reason);

  write("licenses/manifest.json", { ...reviewed, noticeExceptions: [] });
  assert.equal(run("desktop", app).status, 2, "metadata alone must not waive missing notices");
  write("licenses/manifest.json", { ...reviewed, unresolved: manifest.unresolved });
  assert.equal(run("desktop", app).status, 2, "exceptions must not clear independent native limitations");
  write("licenses/manifest.json", reviewed);

  for (const [key, value] of [
    ["license", "Apache-2.0"],
    ["author", "Changed Author"],
  ]) {
    await pack({ ...metadata, [key]: value });
    const changed = run("desktop", app);
    assert.equal(changed.status, 1);
    assert.match(changed.stderr, new RegExp(`packaged ${key} differs`));
  }
  await pack();
  write("archive/node_modules/parent/node_modules/fixture-native/package.json", { ...metadata, version: "2.0.0" });
  await pack();
  const upgraded = run("desktop", app);
  assert.equal(upgraded.status, 1);
  assert.match(upgraded.stderr, /notice exception version differs/);
  write("archive/node_modules/parent/node_modules/fixture-native/package.json", { name: "unreviewed", version: "1.0.0", license: "MIT" });
  await pack();
  const unreviewed = run("desktop", app);
  assert.equal(unreviewed.status, 2, `unreviewed packages must still fail: ${unreviewed.stderr || unreviewed.stdout}`);

  write(`${resources}/licenses/declaration.json`, "{}");
  const stale = run("desktop", app);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /packaged notice is missing or differs/);
});
