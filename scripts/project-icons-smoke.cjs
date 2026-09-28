/** Real Electron image decoding and cache measurements; no windows or live profile. */
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const desktop = path.resolve(__dirname, "../apps/desktop");

async function launch() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename, ...process.argv.slice(2)], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

/** A real PNG wrapped in the ICO directory used by Next.js favicons. */
function pngIcon(png, size) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = size;
  header[7] = size;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

async function checkBitmapIcon(dir, createIconPreview) {
  const { nativeImage } = require("electron");
  const bitmap = Buffer.alloc(64);
  bitmap.writeUInt32LE(40, 0);
  bitmap.writeInt32LE(2, 4);
  bitmap.writeInt32LE(4, 8);
  bitmap.writeUInt16LE(1, 12);
  bitmap.writeUInt16LE(32, 14);
  // Bottom-up BGRA: blue/white, then red/green. No alpha; transparency comes from the mask.
  bitmap.set([255, 0, 0, 0, 255, 255, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0], 40);
  bitmap[60] = 0x40;
  const file = path.join(dir, "bitmap.ico");
  await fs.writeFile(file, pngIcon(bitmap, 2));
  const preview = await createIconPreview(file);
  const decoded = nativeImage.createFromDataURL(preview.dataUrl);
  assert.deepEqual(decoded.getSize(), { width: 2, height: 2 });
  assert.deepEqual([...decoded.toBitmap()], [0, 0, 255, 255, 0, 0, 0, 0, 255, 0, 0, 255, 255, 255, 255, 255]);
}

async function checkFavicons(dir, createIconPreview, ProjectIcons) {
  const { nativeImage } = require("electron");
  const iconRoot = path.join(dir, "icon-repo");
  await fs.mkdir(path.join(iconRoot, "app"), { recursive: true });
  const source = nativeImage.createFromPath(path.join(desktop, "resources/icon.png")).resize({ width: 48, height: 48 });
  const file = path.join(iconRoot, "app/favicon.ico");
  await fs.writeFile(file, pngIcon(source.toPNG(), 48));
  const preview = await createIconPreview(file);
  const decoded = nativeImage.createFromDataURL(preview.dataUrl);
  assert.deepEqual(decoded.getSize(), { width: 48, height: 48 });
  assert.deepEqual(decoded.toBitmap(), source.toBitmap());
  const state = await new ProjectIcons(path.join(dir, "ico-cache"), createIconPreview).get(iconRoot);
  assert.equal(state.selected?.path, "app/favicon.ico");
  await checkBitmapIcon(dir, createIconPreview);
  const repo = process.argv[2];
  if (repo) {
    const actual = await new ProjectIcons(path.join(dir, "repo-cache"), createIconPreview).get(path.resolve(repo));
    assert.equal(actual.selected?.path, "app/favicon.ico");
    console.log(JSON.stringify({ repository: repo, selected: actual.selected.path, previewBytes: actual.selected.dataUrl.length }));
  }
}

async function checkStackCache(dir, ProjectIcons, createIconPreview) {
  const { detectProjectStack } = require("../apps/desktop/src/main/project-stack.ts");
  const root = process.argv[3];
  if (!root) return;
  let detections = 0;
  const detect = async (repo) => {
    detections++;
    return detectProjectStack(repo);
  };
  const cache = path.join(dir, "stack-cache");
  const service = new ProjectIcons(cache, createIconPreview, detect);
  const start = performance.now();
  const state = await service.get(path.resolve(root));
  const coldMs = performance.now() - start;
  assert.equal(state.fallback, "nestjs");
  assert.equal(state.selected, null);
  const warm = performance.now();
  for (let index = 0; index < 100; index++) await service.get(path.resolve(root));
  const warmMs = performance.now() - warm;
  assert.deepEqual(await new ProjectIcons(cache, createIconPreview, detect).get(path.resolve(root)), state);
  assert.equal(detections, 1);
  console.log(JSON.stringify({ repository: root, fallback: state.fallback, coldMs, cached100ReadsMs: warmMs, cachedStateBytes: Buffer.byteLength(JSON.stringify(state)), detections }));
}

async function check() {
  const { app } = require("electron");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openorc-project-icons-"));
  app.setPath("userData", path.join(dir, "profile"));
  require("tsx/cjs");
  const { createIconPreview } = require("../apps/desktop/src/main/project-icon-images.ts");
  const { ProjectIcons } = require("../apps/desktop/src/main/project-icons.ts");
  await app.whenReady();
  try {
    await checkFavicons(dir, createIconPreview, ProjectIcons);
    await checkStackCache(dir, ProjectIcons, createIconPreview);
    let decodes = 0;
    const preview = async (file) => {
      decodes++;
      return createIconPreview(file);
    };
    const cache = path.join(dir, "cache");
    const service = new ProjectIcons(cache, preview);
    const root = path.resolve(__dirname, "..");
    const start = performance.now();
    const state = await service.get(root);
    const coldMs = performance.now() - start;
    assert.ok(state.candidates.length > 0);
    assert.equal(state.selected?.path, "apps/desktop/resources/icon.png");
    const firstDecodes = decodes;
    const warm = performance.now();
    for (let index = 0; index < 100; index++) assert.deepEqual(await service.get(root), state);
    const warmMs = performance.now() - warm;
    assert.equal(decodes, firstDecodes);
    assert.deepEqual(await new ProjectIcons(cache, preview).get(root), state);
    assert.equal(decodes, firstDecodes);
    const svgFile = path.join(dir, "icon.svg");
    await fs.writeFile(svgFile, '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><path d="M8 8h48v48H8z" fill="#888"/></svg>');
    assert.ok((await createIconPreview(svgFile)).dataUrl.startsWith("data:image/svg+xml;base64,"));
    await fs.writeFile(svgFile, '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><image href="https://example.com/image.png"/></svg>');
    await assert.rejects(() => createIconPreview(svgFile), /self-contained/);
    const bytes = Buffer.byteLength(JSON.stringify(state));
    console.log(
      JSON.stringify({
        result: "PASS",
        coldMs: Math.round(coldMs),
        cached100ReadsMs: Math.round(warmMs * 100) / 100,
        decodes: firstDecodes,
        candidates: state.candidates.length,
        cachedBytes: bytes,
        selected: state.selected.path,
      }),
    );
    await fs.rm(dir, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    await fs.rm(dir, { recursive: true, force: true });
    app.exit(1);
  }
}

if (process.versions.electron) void check();
else void launch();
