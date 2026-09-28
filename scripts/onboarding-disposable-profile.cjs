#!/usr/bin/env node

/**
 * Launches OpenOrc with a fresh Electron profile for onboarding QA.
 *
 * Usage:
 *   node scripts/onboarding-disposable-profile.cjs
 *   node scripts/onboarding-disposable-profile.cjs --dev --keep --port 9333
 *   node scripts/onboarding-disposable-profile.cjs --profile /tmp/openorc-onboarding-qa-abc123
 *   node scripts/onboarding-disposable-profile.cjs --directory /path/to/repository
 *
 * The default launches the built desktop app. Pass --dev to use electron-vite.
 * The profile is removed after the app exits unless --keep is present.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : (args[index + 1] ?? null);
};

if (has("--help")) {
  console.log("Usage: node scripts/onboarding-disposable-profile.cjs [--dev] [--keep] [--port PORT] [--profile PATH] [--directory PATH]");
  process.exit(0);
}

const root = path.resolve(__dirname, "..");
const prefix = path.join(os.tmpdir(), "openorc-onboarding-qa-");
const suppliedDirectory = value("--directory") ?? null;
if (suppliedDirectory && (!path.isAbsolute(suppliedDirectory) || !fs.existsSync(suppliedDirectory) || !fs.statSync(suppliedDirectory).isDirectory())) {
  throw new Error("--directory must name an existing absolute directory.");
}
const suppliedProfile = value("--profile") ?? process.env.OPENORC_QA_PROFILE ?? null;
const profile = suppliedProfile ? path.resolve(suppliedProfile) : fs.mkdtempSync(prefix);
if (suppliedProfile && (!path.basename(profile).startsWith("openorc-onboarding-qa-") || !fs.statSync(profile).isDirectory())) {
  throw new Error("--profile must name an existing disposable onboarding QA profile.");
}
const keep = Boolean(suppliedProfile) || has("--keep") || process.env.OPENORC_QA_KEEP_PROFILE === "1";
const port = value("--port") ?? process.env.OPENORC_QA_CDP_PORT ?? "9333";
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error(`Invalid CDP port: ${port}`);
}

const electronArgs = [`--remote-debugging-port=${port}`];
const dev = has("--dev");
let command;
let commandArgs;
if (dev) {
  command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  commandArgs = ["--filter", "@openorc/desktop", "dev", "--", ...electronArgs];
} else {
  const entry = path.join(root, "apps/desktop/out/main/index.mjs");
  if (!fs.existsSync(entry)) {
    fs.rmSync(profile, { recursive: true, force: true });
    throw new Error("Desktop build not found. Run `pnpm --filter @openorc/desktop build` or pass --dev.");
  }
  command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  commandArgs = ["--filter", "@openorc/desktop", "exec", "electron", ...electronArgs, entry];
}

console.log(`[onboarding-qa] disposable profile: ${profile}`);
console.log(`[onboarding-qa] CDP: http://127.0.0.1:${port}`);

const childEnv = { ...process.env, OPENORC_USER_DATA: profile };
if (suppliedDirectory) childEnv.OPENORC_QA_DIRECTORY = suppliedDirectory;
if (!dev) {
  childEnv.NODE_ENV = "production";
  delete childEnv.ELECTRON_RENDERER_URL;
  delete childEnv.VITE_DEV_SERVER_URL;
}
const child = spawn(command, commandArgs, {
  cwd: root,
  env: childEnv,
  stdio: "inherit",
});

const forward = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.once("SIGINT", () => forward("SIGINT"));
process.once("SIGTERM", () => forward("SIGTERM"));

child.once("error", (error) => {
  console.error(`[onboarding-qa] launch failed: ${error.message}`);
});

child.once("exit", (code, signal) => {
  if (keep) console.log(`[onboarding-qa] kept profile: ${profile}`);
  else fs.rmSync(profile, { recursive: true, force: true });
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
