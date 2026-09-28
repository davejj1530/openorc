const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");
const ts = require("typescript");

// Run the real measurement in Chromium: fake timers cannot distinguish a late
// wakeup from a task that actually blocks the renderer.
test("renderer measurement ignores late timers but catches blocking work and phase boundaries", { timeout: 20000 }, () => {
  const desktop = createRequire(path.resolve(__dirname, "../apps/desktop/package.json"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openorc-bench-measurement-"));
  try {
    const source = fs.readFileSync(path.resolve(__dirname, "../apps/desktop/src/renderer/src/lib/main-thread-measurement.ts"), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
    fs.writeFileSync(path.join(dir, "measurement.js"), compiled);
    fs.copyFileSync(path.join(__dirname, "fixtures/benchmark-measurement.html"), path.join(dir, "index.html"));
    fs.writeFileSync(
      path.join(dir, "main.cjs"),
      `
      const { app, BrowserWindow } = require("electron");
      app.setPath("userData", ${JSON.stringify(path.join(dir, "profile"))});
      app.whenReady().then(async () => {
        const win = new BrowserWindow({ webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
        win.webContents.on("console-message", event => {
          if (!event.message.startsWith("[measurement] ")) return;
          console.log(event.message);
          app.exit(0);
        });
        await win.loadFile(${JSON.stringify(path.join(dir, "index.html"))});
      }).catch(error => { console.error(error); app.exit(1); });
      setTimeout(() => app.exit(1), 12000).unref();
    `,
    );
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(desktop("electron"), [path.join(dir, "main.cjs")], { env, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    const line = result.stdout.split("\n").find((line) => line.startsWith("[measurement] "));
    assert.ok(line, result.stdout);
    const report = JSON.parse(line.slice("[measurement] ".length));
    assert.equal(report.error, undefined, report.error);
    console.log(JSON.stringify(report));
    assert.ok(report.delayedCallbacks >= 6, "the slow timer scenario must actually execute");
    assert.equal(report.delayed.longTasksTotal, 0, "late timers alone must not fail the bridge budget");
    assert.ok(report.frozen.longTasksTotal >= 6, "six real freezes must exceed the bridge budget of five");
    assert.ok(report.frozen.longestTaskMs >= 60);
    assert.ok(report.boundary.longTasksTotal >= 1, "finishing inside the blocked task must not discard it");
    assert.ok(report.boundary.longestTaskMs >= 60);
    assert.equal(report.next.longTasksTotal, 0, "previous phases must not leak into the next phase");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
