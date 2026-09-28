#!/usr/bin/env node
// Checks a package as it ships, signed or not, from the outside: its Electron fuses, where its native code lives, that
// it starts and opens its window, and that the switches another program could use to take it over do nothing.
// Uses only disposable data. The smoke package (package:smoke) fails it on purpose: it keeps --inspect on.
// Node 24: node scripts/packaged-release-check.cjs <absolute-app-path>
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { setTimeout: delay } = require("node:timers/promises");
const { windows, packagedEnvironment, packagedExecutable } = require("./fixtures/packaged-environment.cjs");
const { verifyNativeTarget } = require("./packaged-native-target.cjs");

const desktopRequire = createRequire(path.resolve(__dirname, "../apps/desktop/package.json"));
const { getCurrentFuseWire, FuseV1Options } = desktopRequire("@electron/fuses");
// The library reports each fuse as its byte in the binary: "1" on, "0" off.
const [off, on] = ["0".charCodeAt(0), "1".charCodeAt(0)];

const appPath = process.argv[2];
assert.equal(process.argv.length, 3, "Usage: node scripts/packaged-release-check.cjs <absolute-app-path>");
const executable = packagedExecutable(appPath);
const { root: home, profile, env } = packagedEnvironment();
const launched = [];

async function until(check, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error(`Timed out: ${label}`);
}

async function verifyFuses() {
  const wire = await getCurrentFuseWire(windows ? executable : appPath);
  const expected = {
    RunAsNode: off,
    EnableNodeOptionsEnvironmentVariable: off,
    EnableNodeCliInspectArguments: off,
    EnableCookieEncryption: on,
    EnableEmbeddedAsarIntegrityValidation: on,
    OnlyLoadAppFromAsar: on,
  };
  for (const [fuse, state] of Object.entries(expected)) assert.equal(wire[FuseV1Options[fuse]], state, `${fuse} fuse`);
  console.log("PASS fuses: no Node mode, NODE_OPTIONS or --inspect; cookies encrypted; code only from the checked archive");
}

/** The code signing team of a macOS executable or bundle, or null when it has none. */
function teamOf(file) {
  const { stderr } = spawnSync("codesign", ["-dv", "--verbose=2", file], { encoding: "utf8" });
  const team = /^TeamIdentifier=(.+)$/m.exec(stderr)?.[1];
  return team && team !== "not set" ? team : null;
}

function machOFiles(dir) {
  const magic = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...machOFiles(file));
    else if (entry.isFile() && fs.statSync(file).size >= 4) {
      const head = Buffer.alloc(4);
      const fd = fs.openSync(file, "r");
      fs.readSync(fd, head, 0, 4, 0);
      fs.closeSync(fd);
      if (magic.has(head.readUInt32BE(0))) found.push(file);
    }
  }
  return found;
}

/**
 * Native code must sit outside app.asar: Electron would copy it out to a temporary file to load it, where no signature
 * of ours covers it. On a signed Mac package, every executable file must carry the app's team, because the hardened
 * runtime's library validation refuses to load anything else.
 */
function verifyNativeCode() {
  const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
  const asar = createRequire(builderRequire.resolve("app-builder-lib"))("@electron/asar");
  const archive = path.join(appPath, windows ? "resources" : "Contents/Resources", "app.asar");
  const entries = asar.listPackage(archive);
  assert.deepEqual(
    entries.filter((entry) => entry.endsWith(".map")),
    [],
    "Source maps must stay outside the distributed app",
  );
  console.log("PASS source maps: none in the packaged app or its dependencies");
  assert.deepEqual(
    entries.filter((entry) => /(?:^|\/)node_modules\/cytoscape-fcose\/demo(?:\/|$)/.test(entry.replaceAll("\\", "/"))),
    [],
    "Third-party cytoscape-fcose demos must stay outside the distributed app",
  );
  console.log("PASS library demos: no cytoscape-fcose demo files in the packaged app");
  // Release runners build and run natively. Check the inventory as well as startup:
  // a working app can still accidentally ship another platform's unused binaries.
  verifyNativeTarget(entries, process.platform, process.arch);
  console.log(`PASS native dependency target: ${process.platform}-${process.arch}, with required bindings and helpers`);
  // Unpacked files keep an entry in the archive's index; only packed ones would be copied out to load.
  const packed = asar.listPackage(archive, { isPack: true }).filter((entry) => entry.startsWith("pack"));
  assert.deepEqual(
    packed.filter((entry) => /\.(node|dylib|so(?:\.\d+)*|dll|exe)$/i.test(entry)),
    [],
    "Native code inside app.asar",
  );
  if (windows) return console.log("PASS native code: none inside the archive");
  const team = teamOf(appPath);
  if (!team) return console.log("PASS native code: none inside the archive (unsigned package, so team signatures were not checked)");
  assert.deepEqual(
    machOFiles(appPath).filter((file) => teamOf(file) !== team),
    [],
    `Executable files not signed by team ${team}`,
  );
  console.log(`PASS native code: none inside the archive; every executable file is signed by team ${team}`);
}

function launch(args, extraEnv = {}) {
  const child = spawn(executable, args, { cwd: home, env: { ...env, ...extraEnv }, detached: !windows, stdio: ["ignore", "pipe", "pipe"] });
  const run = { child, output: "", exited: false };
  run.exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      run.exited = true;
      resolve({ code, signal });
    });
  });
  child.stdout.on("data", (data) => (run.output += data));
  child.stderr.on("data", (data) => (run.output += data));
  launched.push(run);
  return run;
}

function stop(run) {
  if (run.exited || !run.child.pid) return;
  if (windows) spawnSync("taskkill.exe", ["/PID", String(run.child.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-run.child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

/** Waits for a launch that should end on its own, and stops it if it does not. */
async function settle(run, timeout = 20_000) {
  const result = await Promise.race([run.exit, delay(timeout, null)]);
  if (!result) stop(run);
  return result;
}

function hasVectorTable() {
  const file = path.join(profile, "openorc.sqlite");
  if (!fs.existsSync(file)) return false;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_vec'").get()?.name === "memory_vec";
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

async function verifyLaunch() {
  const app = launch(["--inspect=127.0.0.1:0"]);
  await until(() => {
    assert.ok(!app.exited, `The app must keep running:\n${app.output}`);
    return app.output.includes("[main] cold start to did-finish-load");
  }, "app window loaded");
  await until(hasVectorTable, "core ledger with vector search");
  assert.doesNotMatch(app.output, /Debugger listening/, "--inspect must be ignored");
  console.log("PASS startup: the window loads, the core opens its ledger with sqlite-vec, and --inspect is ignored");

  // A second launch hands over to the running app and exits. As Node, it would run this code first.
  const marker = "openorc-release-check-ran-node";
  const asNode = launch(["-e", `console.log("${marker}")`], { ELECTRON_RUN_AS_NODE: "1" });
  await settle(asNode);
  assert.ok(!asNode.output.includes(marker), "ELECTRON_RUN_AS_NODE must not run code");
  console.log("PASS ELECTRON_RUN_AS_NODE does not turn the app into Node");

  const debugging = launch(["--remote-debugging-port=0"]);
  const result = await settle(debugging);
  assert.equal(result?.code, 1, `A remote debugging launch must refuse to start:\n${debugging.output}`);
  assert.match(debugging.output, /does not accept remote debugging/);
  assert.doesNotMatch(debugging.output, /DevTools listening/);
  console.log("PASS remote debugging: refused before any window or debugging port opens");
}

async function main() {
  await verifyFuses();
  verifyNativeCode();
  await verifyLaunch();
}

main()
  .catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const run of launched) stop(run);
    await Promise.all(launched.map((run) => Promise.race([run.exit, delay(5000)])));
    fs.rmSync(home, { recursive: true, force: true });
  });
