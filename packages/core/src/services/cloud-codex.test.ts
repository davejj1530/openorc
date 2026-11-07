import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalSandboxProvider } from "@openorc/cloud";
import { runs, settings } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import type { Project } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { inheritedProbe } from "./shell-environment.js";

/**
 * Stands in for Codex on this Mac and in the sandbox. `login` writes a ChatGPT login to CODEX_HOME; `app-server` answers
 * the adapter, keeps each thread's session under CODEX_HOME/sessions like Codex, refuses to resume one it cannot find,
 * reads and refreshes the account, and refreshes its own login during a turn whose prompt says "refresh", as Codex does
 * after a 401. `exec resume --json` answers once. Every turn appends to FAKE_LOG.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.CODEX_HOME || path.join(process.env.HOME, ".codex");
const authFile = path.join(home, "auth.json");
const args = process.argv.slice(2);
const login = (stamp) => JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "access-" + stamp, refresh_token: "refresh-" + stamp }, last_refresh: new Date(stamp).toISOString() });
const auth = () => (fs.existsSync(authFile) ? JSON.parse(fs.readFileSync(authFile, "utf8")) : null);
const rollouts = () => {
  const found = [];
  const walk = (dir) => { for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) { const p = path.join(dir, name); if (fs.statSync(p).isDirectory()) walk(p); else found.push(p); } };
  walk(path.join(home, "sessions"));
  return found;
};
const rolloutOf = (id) => rollouts().find((file) => file.endsWith("-" + id + ".jsonl"));
const log = (entry) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cwd: process.cwd(), home, mode: auth() && auth().auth_mode, ...entry }) + "\\n");
if (args[0] === "--version") { console.log("codex-cli 0.166.0"); process.exit(0); }
if (args[0] === "login") {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(authFile, login(Date.now()));
  console.log("Successfully logged in");
  process.exit(0);
}
if (args[0] === "exec") {
  const [id, prompt] = args.slice(-2);
  const file = rolloutOf(id);
  if (!file) { console.error("no rollout for " + id); process.exit(1); }
  fs.appendFileSync(file, JSON.stringify({ type: "response_item", payload: { prompt } }) + "\\n");
  fs.writeFileSync("carried-on.txt", "done in the cloud\\n");
  log({ id, prompt, exec: true, permission: args.find((arg) => arg.startsWith("sandbox_mode=")) || null });
  for (const line of [{ type: "thread.started", thread_id: id }, { type: "turn.started" }, { type: "item.completed", item: { id: "m", type: "agent_message", text: "Carried on in the cloud" } }, { type: "turn.completed", usage: {} }]) console.log(JSON.stringify(line));
  process.exit(0);
}
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let thread = null;
let held = null;
const turn = (prompt) => {
  if (prompt.includes("refresh")) fs.writeFileSync(authFile, login(Date.now() + 1000));
  fs.appendFileSync(rolloutOf(thread), JSON.stringify({ type: "response_item", payload: { prompt } }) + "\\n");
  log({ id: thread, prompt, earlier: fs.readFileSync(rolloutOf(thread), "utf8").trim().split("\\n").length - 1 });
  emit({ method: "turn/started", params: { threadId: thread, turn: { id: "t-" + Date.now() } } });
  const finish = () => {
    emit({ method: "item/completed", params: { threadId: thread, item: { id: "m-" + Date.now(), type: "agentMessage", text: "Done" } } });
    emit({ method: "turn/completed", params: { threadId: thread, turn: { id: "t", status: "completed" } } });
  };
  if (prompt.includes("slowly")) { fs.writeFileSync("started-here.txt", "begun on the Mac\\n"); held = setTimeout(finish, 60000); } else finish();
};
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined || message.id === undefined) return;
  const answer = (result) => emit({ id: message.id, result });
  const params = message.params || {};
  if (message.method === "thread/start") {
    thread = "019a-" + Date.now();
    const dir = path.join(home, "sessions", "2026", "11", "02");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "rollout-2026-11-02T10-00-00-" + thread + ".jsonl"), JSON.stringify({ type: "session_meta", payload: { id: thread, cwd: process.cwd() } }) + "\\n");
    return answer({ thread: { id: thread } });
  }
  if (message.method === "thread/resume") {
    if (!rolloutOf(params.threadId)) return emit({ id: message.id, error: { code: -32600, message: "no rollout found for thread id " + params.threadId } });
    thread = params.threadId;
    return answer({ thread: { id: thread } });
  }
  if (message.method === "account/read") {
    if (params.refreshToken) fs.writeFileSync(authFile, login(Date.now()));
    return answer({ account: { type: "chatgpt", email: "qa@example.com", planType: "plus" } });
  }
  if (message.method === "turn/start") {
    answer({ turn: { id: "t" } });
    return turn(params.input.map((part) => part.text || "").join(""));
  }
  if (message.method === "turn/interrupt" && held) {
    clearTimeout(held);
    emit({ method: "turn/completed", params: { threadId: thread, turn: { id: "t", status: "interrupted" } } });
  }
  answer({});
});
`;

let root: string;
let macHome: string;
let log: string;
let core: OpenOrc;
let project: Project;
let codexLogin: string | null;

interface Turn {
  cwd: string;
  home: string;
  mode: string | null;
  id: string;
  prompt: string;
  earlier?: number;
  exec?: boolean;
  permission?: string | null;
}
const turns = (): Turn[] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Turn)
    : [];

async function until(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-cloud-codex-")));
  const checkout = path.join(root, "app");
  await mkdir(checkout);
  await git(checkout, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(checkout, "README.md"), "# Codex fixture\n");
  await commitAll(checkout, "Fixture baseline");
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "codex"), FAKE_CODEX);
  await chmod(path.join(bin, "codex"), 0o755);
  macHome = path.join(root, "mac-codex");
  log = path.join(root, "turns.jsonl");
  const env = { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, CODEX_HOME: macHome, FAKE_LOG: log, OPENORC_CODEX_BIN: path.join(bin, "codex"), OPENORC_CLAUDE_BIN: "/usr/bin/false" };
  vi.stubEnv("CODEX_HOME", macHome);
  vi.stubEnv("FAKE_LOG", log);
  const sandboxes = new LocalSandboxProvider(path.join(root, "sandboxes"), () => env, 1500);
  codexLogin = null;
  const store = { load: async () => codexLogin, save: async (value: string) => void (codexLogin = value || null) };
  let cloudSettings: string | null = null;
  const settingsStore = { load: async () => cloudSettings, save: async (value: string) => void (cloudSettings = value) };
  core = await OpenOrc.create({
    dataDir: path.join(root, "data"),
    ephemeral: true,
    transport: { push: () => {} },
    shellProbe: inheritedProbe(env),
    cloudSandboxes: sandboxes,
    codexCloudSecrets: store,
    cloudSecrets: settingsStore,
  });
  settings.set(core.db, "extraction.provider", "off");
  vi.spyOn(core.textGeneration, "title").mockResolvedValue(null);
  vi.spyOn(core.runs, "models").mockResolvedValue([{ id: "fixture", label: "Fixture", agent: "codex", isDefault: true, efforts: ["high"], defaultEffort: "high", fastMode: { supported: false } }]);
  project = await core.projects.import(checkout);
});

afterEach(async () => {
  await core.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const turn = { agent: "codex", model: "fixture", effort: undefined, mode: "act", permissionMode: "trusted", attachments: undefined } as const;
const stored = () => JSON.parse(codexLogin ?? "null") as { mode: string; auth: string; email: string | null } | null;
const lastRefresh = () => Date.parse((JSON.parse(stored()!.auth) as { last_refresh: string }).last_refresh);

async function signIn(): Promise<void> {
  await core.codexCloudLogin.signIn();
  await until(() => stored() !== null);
  for (let tries = 0; tries < 200 && (await core.codexCloudLogin.status()).signingIn; tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
}

it("signs Codex in for the cloud in a folder of its own, refreshes the login here once it is a day old, and keeps one refreshed elsewhere", async () => {
  await signIn();
  expect(stored()).toMatchObject({ mode: "chatgpt", email: "qa@example.com" });
  expect(await core.codexCloudLogin.status()).toMatchObject({ mode: "chatgpt", email: "qa@example.com", plan: "plus", signingIn: false, error: null });
  // This Mac's own Codex folder is never touched.
  expect(existsSync(path.join(macHome, "auth.json"))).toBe(false);

  const fresh = stored()!.auth;
  expect(await core.codexCloudLogin.forSandbox()).toBe(fresh);
  const old = JSON.stringify({ ...JSON.parse(fresh), last_refresh: new Date(Date.now() - 2 * 86_400_000).toISOString() });
  codexLogin = JSON.stringify({ ...stored(), auth: old });
  const store = core.codexCloudLogin as unknown as { cache: unknown };
  store.cache = undefined;
  const refreshed = await core.codexCloudLogin.forSandbox();
  expect(refreshed).not.toBe(old);
  expect(Date.now() - lastRefresh()).toBeLessThan(60_000);

  const later = JSON.stringify({ ...JSON.parse(refreshed!), last_refresh: new Date(Date.now() + 5000).toISOString() });
  await core.codexCloudLogin.keep(later);
  expect(stored()!.auth).toBe(later);
  await core.codexCloudLogin.keep(old);
  expect(stored()!.auth).toBe(later);

  await core.codexCloudLogin.saveApiKey("sk-test-0123456789");
  expect(JSON.parse(stored()!.auth)).toEqual({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test-0123456789" });
  await core.codexCloudLogin.remove();
  expect(await core.codexCloudLogin.status()).toMatchObject({ mode: null });
}, 40_000);

it("runs a cloud Codex conversation in its sandbox with the cloud login, and takes back a login Codex refreshed there", async () => {
  await signIn();
  const { thread } = await core.threads.start({ ...turn, title: "Cloud Codex", projectId: project.id, prompt: "Start in the cloud", cloud: true });
  await until(() => turns().length === 1 && core.runs.threadActivity(thread.id) === "idle");
  const sandbox = path.join(root, "sandboxes", `openorc-${thread.id}`);
  expect(turns()[0]).toMatchObject({ cwd: path.join(sandbox, "repo"), home: path.join(sandbox, ".openorc", "codex"), mode: "chatgpt" });
  expect(existsSync(path.join(macHome, "auth.json"))).toBe(false);

  const before = lastRefresh();
  await core.threads.continueThread(thread.id, { ...turn, prompt: "Now refresh" });
  await until(() => turns().length === 2);
  await until(() => lastRefresh() > before);
  expect(turns()[1]).toMatchObject({ id: turns()[0]!.id, earlier: 2 });
}, 40_000);

it("moves a Codex conversation that ran on this Mac to the cloud, where it resumes its thread", async () => {
  await signIn();
  const { thread } = await core.threads.start({ ...turn, title: "Here first", projectId: project.id, prompt: "Start here", workspaceMode: "worktree" });
  await until(() => turns().length === 1 && core.runs.threadActivity(thread.id) === "idle");
  expect(turns()[0]).toMatchObject({ home: macHome, cwd: core.threads.get(thread.id)!.worktreePath });
  await core.cloudHandoff.move(thread.id);
  await until(() => core.threads.get(thread.id)!.cloud?.state === "ready");
  await core.threads.continueThread(thread.id, { ...turn, prompt: "Go on in the cloud" });
  await until(() => turns().length === 2);
  const sandbox = path.join(root, "sandboxes", `openorc-${thread.id}`);
  expect(turns()[1]).toMatchObject({ id: turns()[0]!.id, cwd: path.join(sandbox, "repo"), home: path.join(sandbox, ".openorc", "codex"), earlier: 2 });
}, 40_000);

it("carries a Codex turn on in the cloud while this Mac sleeps, with codex exec, and brings it into the conversation", async () => {
  await signIn();
  await core.cloudSettings.setTakeover(true);
  const { thread } = await core.threads.start({ ...turn, title: "Takeover", projectId: project.id, prompt: "Start here", workspaceMode: "worktree" });
  await until(() => turns().length === 1 && core.runs.threadActivity(thread.id) === "idle");
  const sessionId = turns()[0]!.id;
  const worktree = core.threads.get(thread.id)!.worktreePath!;
  await core.threads.continueThread(thread.id, { ...turn, prompt: "Work slowly" });
  const standbys = (core.cloudStandby as unknown as { standbys: Map<string, { turn: { sessionId: string | null } | null }> }).standbys;
  await until(() => existsSync(path.join(worktree, "started-here.txt")) && standbys.get(thread.id)?.turn?.sessionId === sessionId);

  await core.cloudStandby.away();
  await until(() => turns().some((entry) => entry.exec === true));
  const sandbox = path.join(root, "sandboxes", `openorc-${thread.id}`);
  expect(turns().find((entry) => entry.exec)).toMatchObject({ id: sessionId, cwd: path.join(sandbox, "repo"), mode: "chatgpt", permission: 'sandbox_mode="workspace-write"' });

  await core.cloudStandby.back();
  expect(core.threads.get(thread.id)!.cloud).toMatchObject({ state: "ready" });
  await until(() => existsSync(path.join(worktree, "carried-on.txt")));
  expect(runs.listForThread(core.db, thread.id).at(-1)).toMatchObject({ agent: "codex", state: "success", externalSessionId: sessionId, resultText: "Carried on in the cloud" });
}, 90_000);
