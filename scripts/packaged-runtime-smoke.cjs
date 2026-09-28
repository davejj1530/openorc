#!/usr/bin/env node
// Run against the smoke package (pnpm --filter @openorc/desktop package:smoke), a macOS .app or Windows application
// directory. It reads the main process through Node's inspector, which every other package switches off with a fuse;
// scripts/packaged-release-check.cjs checks the package that ships. Uses only disposable data.
// Node 24: node scripts/packaged-runtime-smoke.cjs <absolute-app-path> [--keychain-only | --updates-only]
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { createHash } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { windows, packagedEnvironment, packagedExecutable } = require("./fixtures/packaged-environment.cjs");

const appPath = process.argv[2];
const keychainOnly = process.argv[3] === "--keychain-only";
const updatesOnly = process.argv[3] === "--updates-only";
assert.ok(process.argv.length <= 4 && (!process.argv[3] || keychainOnly || updatesOnly), "Only --keychain-only or --updates-only is supported after the app path");
assert.ok(!keychainOnly || !windows, "--keychain-only is macOS-only");
const executable = packagedExecutable(appPath);
const { root, profile, repository, fixtureBin, git, env } = packagedEnvironment();
const syntheticKey = "synthetic-packaged-smoke-not-a-real-api-key";
const replacementKey = "synthetic-packaged-smoke-replacement-not-a-real-api-key";
let current;
let logs = "";

async function until(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

// This is a test-only connection to this child process's loopback Node inspector.
// No application hooks or modified archive entrypoint are needed.
async function inspector(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let sequence = 0;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Packaged app inspector disconnected"));
    }
    pending.clear();
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return {
    close: () => socket.close(),
    async evaluate(expression, timeout = 90_000) {
      const id = ++sequence;
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Object.assign(new Error("Packaged app evaluation timed out"), { code: "SMOKE_EVALUATION_TIMEOUT" }));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    },
  };
}

async function launch(empty = true) {
  let stderr = "";
  const child = spawn(executable, ["--inspect=127.0.0.1:0"], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const session = { child, exited: false, inspector: null };
  current = session;
  session.exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      session.exited = true;
      session.exitDetails = { code, signal };
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      session.error = error;
      session.exited = true;
      resolve({ code: null, signal: null });
    });
  });
  child.stdout.on("data", (data) => {
    logs = (logs + data).slice(-80_000);
  });
  child.stderr.on("data", (data) => {
    stderr += data;
    logs = (logs + data).slice(-80_000);
  });
  await until(() => {
    if (session.error) throw session.error;
    assert.ok(!session.exited, `Packaged app must stay running: ${JSON.stringify(session.exitDetails)}`);
    return /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.test(stderr);
  }, "main-process inspector");
  session.inspector = await inspector(stderr.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)[1]);
  session.main = (expression, timeout) => session.inspector.evaluate(expression, timeout);
  // The inspector can accept requests before Electron installs its built-in
  // module loader. Wait for that boundary, not just the inspector's socket.
  await until(
    () =>
      session.main(`(() => {
        const module = process.getBuiltinModule('module');
        if (typeof module.createRequire !== 'function') return false;
        const require = module.createRequire(process.resourcesPath + '/app.asar/package.json');
        try {
          // The explicit main entry cannot resolve the npm electron launcher
          // while the built-in module loader is still initializing.
          const electron = require('electron/main');
          if (typeof electron.app?.isReady !== 'function') return false;
          globalThis.smoke = { require, electron };
          return true;
        } catch (error) {
          if (error.code === 'MODULE_NOT_FOUND' && error.message.startsWith("Cannot find module 'electron/main'")) return false;
          throw error;
        }
      })()`),
    "Electron main-process module loader",
  );
  await until(
    () => session.main(`smoke.electron.app.isReady() && smoke.electron.BrowserWindow.getAllWindows().some(w => !w.webContents.isLoadingMainFrame() && w.webContents.getURL().startsWith('file://'))`),
    "packaged renderer startup",
  );
  session.renderer = (expression) => session.main(`smoke.electron.BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(expression)})`);
  const runtime = await session.main(
    `({packaged:smoke.electron.app.isPackaged,profile:smoke.electron.app.getPath('userData'),home:process.env.HOME,electron:process.versions.electron,node:process.versions.node,arch:process.arch})`,
  );
  assert.equal(runtime.packaged, true);
  assert.equal(runtime.profile, profile);
  assert.equal(runtime.home, env.HOME);
  assert.ok(await session.renderer(`!!window.openorc && document.querySelector('#root')?.childElementCount > 0`), "Preload and renderer mounted");
  await session.renderer(`(${installRpcBridge.toString()})()`);
  session.rpc = (method, params = {}) => session.renderer(`window.packagedSmokeRpc(${JSON.stringify(method)},${JSON.stringify(params)})`);
  const info = await session.rpc("system.info");
  assert.equal(info.dataDir, profile);
  assert.equal(info.harnesses.length, 3);
  for (const harness of info.harnesses) {
    assert.equal(harness.path, path.join(fixtureBin, harness.id + (windows ? ".exe" : "")), "Core login discovery resolves only disposable provider fixtures");
    assert.equal(harness.state, "check_failed", "Provider fixture cannot authenticate or run an agent");
  }
  if (empty) assert.deepEqual(await session.rpc("projects.list"), []);
  console.log(`PASS packaged renderer/preload/core startup (Electron ${runtime.electron}, Node ${runtime.node}, ${runtime.arch})`);
  return session;
}

function installRpcBridge() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("RPC port not received")), 20_000);
    const receive = (event) => {
      if (event.data !== "openorc:port" || !event.ports[0]) return;
      window.removeEventListener("message", receive);
      clearTimeout(timer);
      const port = event.ports[0];
      const pending = new Map();
      let id = 1_000_000;
      // Keep the application's own onmessage handler intact.
      port.addEventListener("message", ({ data }) => {
        const request = pending.get(data.id);
        if (!request || !["rpc.result", "rpc.error"].includes(data.type)) return;
        pending.delete(data.id);
        clearTimeout(request.timer);
        if (data.type === "rpc.error") request.reject(new Error(data.message));
        else request.resolve(data.result);
      });
      port.start();
      window.packagedSmokeRpc = (method, params) =>
        new Promise((resolve, reject) => {
          const requestId = ++id;
          const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error(`RPC timeout: ${method}`));
          }, 60_000);
          pending.set(requestId, { resolve, reject, timer });
          port.postMessage({ type: "rpc", id: requestId, method, params });
        });
      resolve(true);
    };
    window.addEventListener("message", receive);
    window.openorc.connectBridge();
  });
}

function killOwnedGroup(session) {
  if (!session?.child.pid) return;
  if (windows) {
    if (!session.exited) {
      try {
        execFileSync("taskkill.exe", ["/PID", String(session.child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        if (!session.exited) session.child.kill();
      }
    }
    return;
  }
  try {
    process.kill(-session.child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function quit(session, force = false) {
  try {
    if (!force && !session.exited && session.main) {
      await session.main("setTimeout(() => smoke.electron.app.quit(), 50); true", 3000).catch(() => {});
    }
    session.inspector?.close();
    if (force) killOwnedGroup(session);
    const result = await Promise.race([session.exit, delay(force ? 3000 : 16_000, { code: null }, { ref: false })]);
    if (!force) assert.equal(result.code, 0, "Packaged app exits cleanly within its deadline");
  } finally {
    // A crashed main process can leave helpers holding pipes open. Sweep its
    // isolated process group even when the main process has already exited.
    killOwnedGroup(session);
    session.child.stdout.destroy();
    session.child.stderr.destroy();
    if (current === session) current = null;
  }
}

async function verifyTerminal(session) {
  const result = await session.renderer(
    `(${async function (cwd, windows) {
      const terminal = window.openorc.terminal;
      const id = "packaged-runtime-smoke";
      let output = "";
      const stopData = terminal.onData(id, (chunk) => {
        output += chunk;
      });
      let stopExit;
      const exited = new Promise((resolve) => {
        stopExit = terminal.onExit(id, resolve);
      });
      try {
        terminal.attach(id);
        const opened = await terminal.open({ id, cwd, cols: 91, rows: 27 });
        if (!opened.running) throw new Error("Packaged PTY did not start");
        terminal.write(id, windows ? "echo native-pty-ok\rexit\r" : "stty size; printf '\\156\\141\\164\\151\\166\\145\\055\\160\\164\\171\\055\\157\\153\\n'; exit 0\n");
        const code = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("PTY exit timed out")), 15_000))]);
        return { code, output };
      } finally {
        stopData();
        stopExit();
        terminal.kill(id);
        terminal.detach(id);
      }
    }.toString()})(${JSON.stringify(repository)}, ${windows})`,
  );
  assert.equal(result.code, 0);
  if (!windows) assert.match(result.output, /27 91/);
  assert.match(result.output, /native-pty-ok/);
  console.log(`PASS packaged node-pty: real shell output${windows ? "" : ", geometry"}, and exit`);
}

async function database(session) {
  await session.main(
    `smoke.db = new (smoke.require('node:sqlite').DatabaseSync)(${JSON.stringify(path.join(profile, "openorc.sqlite"))}, {allowExtension:true}); smoke.db.loadExtension(smoke.require('sqlite-vec').getLoadablePath().replace(/\\.asar([/\\\\])/, '.asar.unpacked$1')); true`,
  );
  const table = await session.main(`smoke.db.prepare("SELECT name FROM sqlite_master WHERE name='memory_vec'").get()`);
  assert.equal(table?.name, "memory_vec", "The real core must have enabled vectors; FTS fallback cannot pass this check");
  console.log("PASS packaged SQLite and sqlite-vec: core created the vector table");
}

async function verifyUpdateDownload(session) {
  // A harmless empty ZIP tests the real downloader and hash checks. Never call
  // quitAndInstall: the fixture is not an application and must not be installed.
  const archive = Buffer.from("UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==", "base64");
  const sha512 = createHash("sha512").update(archive).digest("base64");
  const file = `OpenOrc-99.0.0-${process.arch}.${windows ? "exe" : "zip"}`;
  const channel = `latest-${process.arch}`;
  const metadata = `version: 99.0.0\nfiles:\n  - url: ${file}\n    sha512: ${sha512}\n    size: ${archive.length}\npath: ${file}\nsha512: ${sha512}\nreleaseDate: '2026-09-23T00:00:00Z'\n`;
  let corrupt = true;
  let downloads = 0;
  const server = http.createServer((request, response) => {
    if (request.url?.split("?")[0] === `/${channel}${windows ? "" : "-mac"}.yml`) response.end(metadata);
    else if (request.url?.split("?")[0] === `/${file}`) {
      downloads++;
      response.end(corrupt ? Buffer.from("invalid checksum") : archive);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const fixtureConfig = path.join(profile, "smoke-update.yml");
    fs.writeFileSync(fixtureConfig, `provider: generic\nurl: http://127.0.0.1:${address.port}/\nchannel: ${channel}\nupdaterCacheDirName: openorc-updater-smoke\n`);
    const checked = await session.main(
      `(async () => { const updater = smoke.require('electron-updater').autoUpdater; if (updater.autoDownload || updater.autoInstallOnAppQuit) throw Error('Automatic installation must be disabled'); updater.updateConfigPath = ${JSON.stringify(fixtureConfig)}; const result = await updater.checkForUpdates(); return {available:result.isUpdateAvailable, version:result.updateInfo.version}; })()`,
    );
    assert.deepEqual(checked, { available: true, version: "99.0.0" });
    assert.equal(downloads, 0, "Checking must not download the archive");
    const rejected = await session.main(`smoke.require('electron-updater').autoUpdater.downloadUpdate().then(() => 'unexpected success', error => error.message)`);
    assert.match(rejected, /sha512 checksum mismatch/);
    corrupt = false;
    const downloaded = await session.main(
      `(async () => { const updater = smoke.require('electron-updater').autoUpdater; let version = null; updater.once('update-downloaded', info => { version = info.version; }); await updater.downloadUpdate(); return {version, autoInstallOnAppQuit:updater.autoInstallOnAppQuit}; })()`,
    );
    assert.deepEqual(downloaded, { version: "99.0.0", autoInstallOnAppQuit: false });
    assert.equal(downloads, 2);
    console.log("PASS real updater: loopback feed, no automatic download, corrupt download rejected, retry succeeds; installer never invoked");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function assertNoPlaintext() {
  for (const name of ["openorc.sqlite", "openorc.sqlite-wal", "memory-extraction-key.enc"]) {
    const file = path.join(profile, name);
    if (fs.existsSync(file)) for (const value of [syntheticKey, replacementKey]) assert.ok(!fs.readFileSync(file).includes(Buffer.from(value)), `No synthetic credential plaintext in ${name}`);
  }
  for (const value of [syntheticKey, replacementKey]) assert.ok(!logs.includes(value), "No credential value in application logs");
}

async function verify() {
  if (keychainOnly) {
    console.log("Checking protected storage only: the disposable HOME's own keychain, a disposable app profile and synthetic credentials.");
    await verifyProtectedStorage();
    await assertNoPlaintext();
    return;
  }
  execFileSync(git, ["init", "--quiet", repository], { env, timeout: 10_000 });
  // Project import needs a HEAD. This commit exists only in our temporary fixture.
  execFileSync(
    git,
    [
      "-C",
      repository,
      "-c",
      "user.name=Packaged Smoke",
      "-c",
      "user.email=smoke@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "-c",
      `core.hooksPath=${path.join(root, "empty-hooks")}`,
      "commit",
      "--allow-empty",
      "--no-verify",
      "-m",
      "Packaged runtime fixture",
    ],
    { env, timeout: 10_000 },
  );
  let session = await launch();
  const updateMenu = await session.main(
    `(() => { const item = smoke.electron.Menu.getApplicationMenu()?.getMenuItemById('app-update'); const updater = smoke.require('electron-updater').autoUpdater; return { label: item?.label, enabled: item?.enabled, autoDownload: updater.autoDownload, autoInstallOnAppQuit: updater.autoInstallOnAppQuit, allowPrerelease: updater.allowPrerelease, allowDowngrade: updater.allowDowngrade }; })()`,
  );
  assert.deepEqual(updateMenu, { label: "Check for updates…", enabled: true, autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: true, allowDowngrade: false });
  console.log("PASS packaged updater dependency, native menu, and explicit download/install policy");
  await verifyUpdateDownload(session);
  if (updatesOnly) {
    const version = await session.main("smoke.electron.app.getVersion()");
    await quit(session);
    session = await launch(false);
    assert.equal(await session.main("smoke.electron.app.getVersion()"), version, "Ordinary quit after download must not install an update");
    await quit(session);
    console.log("PASS ordinary quit after downloading leaves the existing installation usable");
    return;
  }
  // Memory is off by default. Turn it on for the embedding checks, without automatic extraction by an agent.
  await session.rpc("memory.settings.set", { enabled: true, provider: "off" });
  await verifyTerminal(session);
  await database(session);
  assert.equal(fs.existsSync(path.join(profile, "models")), false, "Cold model cache starts empty");
  const project = await session.rpc("projects.import", { rootPath: repository });
  const cat = await session.rpc("memory.record", { projectId: project.id, type: "convention", title: "The cat is sleeping on the sofa.", body: "A peaceful household pet." });
  await session.rpc("memory.record", { projectId: project.id, type: "convention", title: "A database migration adds an index.", body: "SQL storage improvements." });
  await until(() => session.main("smoke.db.prepare('SELECT count(*) AS n FROM memory_vec').get().n === 2"), "real core cold download and embeddings", 180_000);
  const search = await session.rpc("memory.search", { projectId: project.id, query: "feline", limit: 2 });
  assert.equal(search[0]?.id, cat.id, "Semantic retrieval finds the cat without a matching word");
  console.log("PASS real core: cold MiniLM download, two stored vectors, semantic retrieval");
  const worker = path.join(__dirname, "fixtures/packaged-runtime-worker.cjs");
  const warm = await session.main(
    `new Promise((resolve,reject) => { const child=smoke.electron.utilityProcess.fork(${JSON.stringify(worker)},[process.resourcesPath,${JSON.stringify(path.join(profile, "models"))}],{stdio:'pipe',env:{...process.env}}); let report,errors=''; const timeout=setTimeout(()=>{child.kill();reject(new Error('Offline embedding worker timeout'));},60000); child.stderr.on('data',d=>errors+=d); child.on('message',m=>{report=m});child.once('exit',code=>{clearTimeout(timeout); if(code===0&&report?.ok)resolve(report);else reject(new Error('Offline embedding worker failed: '+errors));}); })`,
  );
  assert.equal(warm.dimensions, 384);
  console.log("PASS new Electron utility process: packaged ESM FastEmbed, ONNX and JS tokenizer, offline cache and normalized embeddings");
  await session.main("smoke.db.close(); true");
  await quit(session);

  // Initialization may outlive the search API's intentional 500 ms fallback.
  session = await launch(false);
  await database(session);
  await until(async () => (await session.rpc("memory.search", { projectId: project.id, query: "feline", limit: 2 }))[0]?.id === cat.id, "semantic search after app restart");
  await session.main("smoke.db.close(); true");
  await quit(session);
  console.log("PASS persisted memory retrieval and graceful packaged shutdown");
  await verifyProtectedStorage();
  await assertNoPlaintext();
}

async function verifyProtectedStorage() {
  const context = windows ? "this Windows login" : "the disposable HOME's keychain";
  let session = await launch(false);
  let encryption;
  try {
    // An isolated macOS HOME may have no usable keychain. Do this last, with a
    // separate deadline: native keychain access can block Electron's main loop.
    encryption = await session.main("smoke.electron.safeStorage.isEncryptionAvailable()", 15_000);
  } catch (error) {
    if (error.code !== "SMOKE_EVALUATION_TIMEOUT") throw error;
    await quit(session, true);
    console.log(`LIMIT: OS encryption availability did not finish within 15 s with ${context}. Saving/restart/clearing could not be exercised; no keychain unlock or reconfiguration attempted.`);
    process.exitCode = 2;
    return;
  }
  if (encryption) {
    const settings = await session.rpc("memory.settings.set", { apiKey: syntheticKey });
    assert.equal(settings.hasApiKey, true);
    assert.ok(!JSON.stringify(settings).includes(syntheticKey));
    const file = path.join(profile, "memory-extraction-key.enc");
    if (!windows) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(await session.main(`smoke.electron.safeStorage.decryptString(smoke.require('node:fs').readFileSync(${JSON.stringify(file)})) === ${JSON.stringify(syntheticKey)}`), true);
    console.log(`PASS real OS-backed encryption${windows ? "" : " and owner-only credential file"}`);
  } else {
    await assert.rejects(session.rpc("memory.settings.set", { apiKey: syntheticKey }), /protect|encrypt|keychain|storage/i);
    assert.equal((await session.rpc("memory.settings.get")).hasApiKey, false);
    assert.equal(fs.existsSync(path.join(profile, "memory-extraction-key.enc")), false);
    console.log("PASS unavailable protected storage rejects saving; no plaintext fallback");
  }
  await assertNoPlaintext();

  await quit(session);
  if (!encryption) {
    console.log(`LIMIT: safeStorage unavailable with ${context}. Real encryption/restart/clearing remains unverified; no keychain unlock or reconfiguration attempted.`);
    process.exitCode = 2;
    return;
  }
  session = await launch(false);
  assert.equal((await session.rpc("memory.settings.get")).hasApiKey, true);
  assert.equal((await session.rpc("memory.settings.set", { apiKey: replacementKey })).hasApiKey, true);
  await assertNoPlaintext();
  await quit(session);
  session = await launch(false);
  assert.equal((await session.rpc("memory.settings.get")).hasApiKey, true);
  assert.equal(
    await session.main(
      `smoke.electron.safeStorage.decryptString(smoke.require('node:fs').readFileSync(${JSON.stringify(path.join(profile, "memory-extraction-key.enc"))})) === ${JSON.stringify(replacementKey)}`,
    ),
    true,
  );
  assert.equal((await session.rpc("memory.settings.set", { apiKey: "" })).hasApiKey, false);
  assert.equal(await session.main(`smoke.electron.safeStorage.decryptString(smoke.require('node:fs').readFileSync(${JSON.stringify(path.join(profile, "memory-extraction-key.enc"))})) === ''`), true);
  await quit(session);
  session = await launch(false);
  assert.equal((await session.rpc("memory.settings.get")).hasApiKey, false);
  await quit(session);
  console.log("PASS protected credential and its replacement survive restarts; clearing survives another restart");
}

const deadline = setTimeout(() => {
  console.error("FAIL: overall smoke deadline exceeded");
  killOwnedGroup(current);
  process.exitCode = 1;
}, 360_000);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    killOwnedGroup(current);
  });
verify()
  .catch((error) => {
    console.error(error.stack ?? error);
    if (current?.exited) console.error("Packaged process exit:", current.exitDetails);
    console.error(logs.replaceAll(syntheticKey, "[synthetic credential redacted]").replaceAll(replacementKey, "[synthetic credential redacted]"));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (current)
      await quit(current, true).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
    clearTimeout(deadline);
    fs.rmSync(root, { recursive: true, force: true });
  });
