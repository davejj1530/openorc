import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalSandboxProvider } from "@openorc/cloud";
import { checkpoints, cloudWorkspaces, settings } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import type { Project } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";

/**
 * Stands in for Claude Code inside the sandbox. It records where it ran, calls OpenOrc's MCP server through the
 * address it was given, asks the trusted mode's file-boundary hook about two paths, and answers one turn.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("2.1.316 (Claude Code)");
  process.exit(0);
}
const log = { cwd: process.cwd(), args, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null };
const config = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"));
const url = Object.values(config.mcpServers)[0].url;
const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
const hook = settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
const ask = (file) => (hook ? execFileSync("/bin/sh", ["-c", hook], { input: JSON.stringify({ tool_input: { file_path: file } }), encoding: "utf8" }) : null);
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  const message = JSON.parse(line);
  log.prompt = message.message.content[0].text;
  if (log.prompt.includes("slowly")) {
    writeFileSync("progress.txt", "halfway\\n");
    await new Promise((resolve) => setTimeout(resolve, 9500));
  }
  log.mcpUrl = url;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } }),
  });
  log.mcpStatus = response.status;
  log.mcpBody = (await response.text()).slice(0, 400);
  log.inside = ask("notes.txt");
  log.outside = ask("/etc/hosts");
  writeFileSync("made-in-cloud.txt", "hello\\n");
  if (log.prompt.includes("Keep going")) writeFileSync("second.txt", "again\\n");
  writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(log));
  emit({ type: "system", subtype: "init", session_id: "cloud-session", model: "fixture", tools: [] });
  emit({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Done in the cloud" }], usage: { input_tokens: 1, output_tokens: 1 } } });
  emit({ type: "result", subtype: "success", is_error: false, duration_ms: 5, num_turns: 1, total_cost_usd: 0, result: "Done in the cloud", usage: { input_tokens: 1, output_tokens: 1 } });
});
lines.on("close", () => process.exit(0));
`;

let root: string;
let checkout: string;
let core: OpenOrc;
let project: Project;
let log: string;
let sandboxes: LocalSandboxProvider;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-cloud-runs-")));
  checkout = path.join(root, "app");
  await mkdir(checkout);
  await git(checkout, ["init", "-q", "-b", "main"]);
  await git(checkout, ["config", "user.email", "fixture@example.com"]);
  await git(checkout, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(checkout, "README.md"), "# Cloud fixture\n");
  await commitAll(checkout, "Fixture baseline");
  // The fake CLI is only on the sandbox's PATH, so a run that finds it ran in the sandbox.
  const bin = path.join(root, "sandbox-bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "claude"), FAKE_CLAUDE);
  await chmod(path.join(bin, "claude"), 0o755);
  log = path.join(root, "fake-claude.json");
  // A short away window: a sandbox stops on its own whenever nothing keeps it awake for 1.5 s.
  sandboxes = new LocalSandboxProvider(path.join(root, "sandboxes"), () => ({ ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, FAKE_CLAUDE_LOG: log }), 1500);
  let saved: string | null = null;
  const tokenStore = { load: async () => saved, save: async (value: string) => void (saved = value) };
  core = await OpenOrc.create({ dataDir: path.join(root, "data"), ephemeral: true, transport: { push: () => {} }, cloudSandboxes: sandboxes, claudeCloudSecrets: tokenStore });
  settings.set(core.db, "extraction.provider", "off");
  vi.spyOn(core.textGeneration, "title").mockResolvedValue(null);
  vi.spyOn(core.runs, "models").mockResolvedValue([{ id: "fixture", label: "Fixture", agent: "claude", isDefault: true, efforts: ["high"], defaultEffort: "high", fastMode: { supported: false } }]);
  project = await core.projects.import(checkout);
});

/** Processes whose command line names `folder`, such as a simulated sandbox's runner. */
function processesUnder(folder: string): string[] {
  try {
    return execFileSync("pgrep", ["-f", folder], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

afterEach(async () => {
  await core.close();
  // Sandboxes simulated on this Mac stop with the core that started them.
  expect(processesUnder(path.join(root, "sandboxes"))).toEqual([]);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/** A cloud thread's worktree on the Mac, which is made in the background after the thread opens. */
async function worktreeOf(threadId: string): Promise<string> {
  await until(() => Boolean(core.threads.get(threadId)?.worktreePath));
  return core.threads.get(threadId)!.worktreePath!;
}

async function until(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

it("runs a cloud conversation's agent in its sandbox, with OpenOrc's tools and file checks reached from there", async () => {
  const attachment = path.join(root, "sketch.txt");
  await writeFile(attachment, "a sketch\n");
  const { thread } = await core.threads.start({
    agent: "claude",
    model: "fixture",
    effort: undefined,
    mode: "act",
    permissionMode: "trusted",
    attachments: [attachment],
    title: undefined,
    projectId: project.id,
    prompt: "Work in the cloud",
    cloud: true,
  });
  await until(() => existsSync(log));
  const ran = JSON.parse(readFileSync(log, "utf8")) as Record<string, string | number>;
  const repo = path.join(root, "sandboxes", `openorc-${thread.id}`, "repo");

  expect(ran["cwd"]).toBe(await realpath(repo));
  expect(String(ran["mcpUrl"])).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[A-Za-z0-9_-]+$/);
  expect(ran["mcpStatus"]).toBe(200);
  expect(ran["mcpBody"]).toContain('"serverInfo"');
  expect(JSON.parse(String(ran["inside"]))).toEqual({});
  expect(JSON.parse(String(ran["outside"]))).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });

  const uploaded = /(\/\S+\/\.openorc\/attachments\/[0-9a-f]{12}-sketch\.txt)/.exec(String(ran["prompt"]))?.[1];
  expect(uploaded).toBeDefined();
  expect(readFileSync(uploaded!, "utf8")).toBe("a sketch\n");
  expect(String(ran["prompt"])).not.toContain(attachment);

  expect(existsSync(path.join(repo, "made-in-cloud.txt"))).toBe(true);
  // The turn's end brings the sandbox's files to the worktree on the Mac before its checkpoint.
  const mirror = await worktreeOf(thread.id);
  const checkpointed = () => {
    const last = checkpoints.listForThread(core.db, thread.id).at(-1);
    return Boolean(last) && execFileSync("git", ["ls-tree", "--name-only", last!.treeSha], { cwd: mirror, encoding: "utf8" }).includes("made-in-cloud.txt");
  };
  await until(checkpointed);
  expect(readFileSync(path.join(mirror, "made-in-cloud.txt"), "utf8")).toBe("hello\n");
  expect(cloudWorkspaces.get(core.db, thread.id)?.mirror?.snapshot).toMatch(/^[0-9a-f]{40}$/);
  expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" })).toBe(execFileSync("git", ["rev-parse", "HEAD"], { cwd: mirror, encoding: "utf8" }));
});

it("brings the sandbox's changes to the Mac while the agent is still working", async () => {
  const { thread } = await core.threads.start({
    agent: "claude",
    model: "fixture",
    effort: undefined,
    mode: "act",
    permissionMode: "autonomous",
    attachments: undefined,
    title: undefined,
    projectId: project.id,
    prompt: "Work slowly",
    cloud: true,
  });
  const mirror = await worktreeOf(thread.id);
  await until(() => existsSync(path.join(mirror, "progress.txt")), 15_000);
  expect(existsSync(log)).toBe(false);
  await until(() => existsSync(path.join(mirror, "made-in-cloud.txt")), 15_000);
}, 40_000);

it("keeps the sandbox awake while its agent runs, stops it once the agent has closed, and wakes it for the next message", async () => {
  const { thread } = await core.threads.start({
    agent: "claude",
    model: "fixture",
    effort: undefined,
    mode: "act",
    permissionMode: "autonomous",
    attachments: undefined,
    title: undefined,
    projectId: project.id,
    prompt: "Work in the cloud",
    cloud: true,
  });
  await until(() => existsSync(log));
  const mirror = await worktreeOf(thread.id);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const live = core.runs.liveRunForThread(thread.id);
  expect(live).toBeTruthy();

  await core.runs.closeAndWait(live!.id);
  await until(() => processesUnder(path.join(root, "sandboxes")).length === 0, 5000);

  await rm(log, { force: true });
  await core.threads.continueThread(thread.id, { agent: "claude", model: "fixture", effort: undefined, mode: "act", permissionMode: "autonomous", prompt: "Keep going", attachments: undefined });
  await until(() => existsSync(log));
  await until(() => existsSync(path.join(mirror, "second.txt")));
}, 40_000);

it("deletes the sandbox with its thread", async () => {
  const { thread } = await core.threads.start({
    agent: "claude",
    model: "fixture",
    effort: undefined,
    mode: "act",
    permissionMode: "autonomous",
    attachments: undefined,
    title: undefined,
    projectId: project.id,
    prompt: "Work in the cloud",
    cloud: true,
  });
  await until(() => existsSync(log));
  const sandbox = path.join(root, "sandboxes", `openorc-${thread.id}`);
  expect(existsSync(sandbox)).toBe(true);
  await core.threads.delete(thread.id);
  expect(existsSync(sandbox)).toBe(false);
  expect(processesUnder(sandbox)).toEqual([]);
});

it("checks where new cloud threads run in a throwaway sandbox, and shows each step in the cloud status", async () => {
  await core.cloudChecks.start();
  await until(() => core.cloudChecks.status()?.passed !== null, 30_000);
  const check = core.cloudChecks.status()!;
  expect(check).toMatchObject({ provider: "local", passed: true });
  expect(check.steps.map((step) => [step.step, step.state])).toEqual([
    ["sandbox", "done"],
    ["tools", "done"],
    ["runner", "done"],
    ["relay", "done"],
    ["sync", "done"],
    ["remove", "done"],
  ]);
  expect(check.steps[1]?.detail).toContain("Claude Code 2.1.316");
  expect(processesUnder(path.join(root, "sandboxes"))).toEqual([]);
}, 40_000);

it("finishes a turn the agent kept working on while the Mac lost its connection to the sandbox", async () => {
  const { thread } = await core.threads.start({
    agent: "claude",
    model: "fixture",
    effort: undefined,
    mode: "act",
    permissionMode: "autonomous",
    attachments: undefined,
    title: undefined,
    projectId: project.id,
    prompt: "Work slowly",
    cloud: true,
  });
  const repo = path.join(root, "sandboxes", `openorc-${thread.id}`, "repo");
  await until(() => existsSync(path.join(repo, "progress.txt")), 15_000);
  // Every connection into the VM drops, as when the Mac sleeps; the agent's process in the VM keeps going.
  const sandbox = await sandboxes.open(`openorc-${thread.id}`);
  sandbox.dropConnections();
  await new Promise((resolve) => setTimeout(resolve, 300));
  sandbox.dropConnections();
  const mirror = await worktreeOf(thread.id);
  await until(() => {
    const last = checkpoints.listForThread(core.db, thread.id).at(-1);
    return Boolean(last) && execFileSync("git", ["ls-tree", "--name-only", last!.treeSha], { cwd: mirror, encoding: "utf8" }).includes("made-in-cloud.txt");
  }, 25_000);
  expect(existsSync(log)).toBe(true);
  expect(core.runs.liveRunForThread(thread.id)).toBeTruthy();
}, 45_000);

it("lists a conversation's sandbox, removes it once its agent is idle, and sets up a new one from the worktree", async () => {
  const { thread } = await core.threads.start({
    agent: "claude",
    model: "fixture",
    effort: undefined,
    mode: "act",
    permissionMode: "autonomous",
    attachments: undefined,
    title: "Footer",
    projectId: project.id,
    prompt: "Work slowly",
    cloud: true,
  });
  const name = `openorc-${thread.id}`;
  const repo = path.join(root, "sandboxes", name, "repo");
  await until(() => existsSync(path.join(repo, "progress.txt")), 15_000);
  expect(await core.cloudSandboxes.list()).toEqual([expect.objectContaining({ name, provider: "local", thread: { id: thread.id, title: "Footer" }, state: "running", working: true, costUsd: null })]);
  await expect(core.cloudSandboxes.remove(name)).rejects.toThrow("Its conversation's agent is at work there.");

  const mirror = await worktreeOf(thread.id);
  await until(() => existsSync(log) && core.runs.threadActivity(thread.id) === "idle", 25_000);
  await until(() => existsSync(path.join(mirror, "made-in-cloud.txt")));
  await core.cloudSandboxes.remove(name);
  expect(existsSync(path.join(root, "sandboxes", name))).toBe(false);
  expect(core.runs.liveRunForThread(thread.id)).toBeNull();
  expect(core.threads.get(thread.id)!.cloud).toMatchObject({ state: "removed" });
  expect(await core.cloudSandboxes.list()).toEqual([]);

  await rm(log, { force: true });
  await core.threads.continueThread(thread.id, { agent: "claude", model: "fixture", effort: undefined, mode: "act", permissionMode: "autonomous", prompt: "Keep going", attachments: undefined });
  await until(() => existsSync(log));
  // The new sandbox starts from the worktree, which holds what the removed one had synced.
  expect(readFileSync(path.join(repo, "made-in-cloud.txt"), "utf8")).toBe("hello\n");
  expect(core.threads.get(thread.id)!.cloud).toMatchObject({ state: "ready" });
}, 60_000);

it("refuses a cloud conversation for an agent that has not run in a sandbox, before making one", async () => {
  await expect(
    core.threads.start({
      agent: "codex",
      model: "fixture",
      effort: undefined,
      mode: "act",
      permissionMode: "autonomous",
      attachments: undefined,
      title: undefined,
      projectId: project.id,
      prompt: "Work in the cloud",
      cloud: true,
    }),
  ).rejects.toThrow("Only Claude runs in cloud workspaces so far.");
  expect(existsSync(path.join(root, "sandboxes"))).toBe(false);
});

it("sends a commit made on the Mac between turns to the sandbox, and keeps it on the branch", async () => {
  const { thread } = await core.threads.start({
    agent: "claude",
    model: "fixture",
    effort: undefined,
    mode: "act",
    permissionMode: "autonomous",
    attachments: undefined,
    title: undefined,
    projectId: project.id,
    prompt: "Work in the cloud",
    cloud: true,
  });
  const mirror = await worktreeOf(thread.id);
  const repo = path.join(root, "sandboxes", `openorc-${thread.id}`, "repo");
  await until(() => {
    const last = checkpoints.listForThread(core.db, thread.id).at(-1);
    return Boolean(last) && execFileSync("git", ["ls-tree", "--name-only", last!.treeSha], { cwd: mirror, encoding: "utf8" }).includes("made-in-cloud.txt");
  });
  await git(mirror, ["add", "-A"]);
  await git(mirror, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "Committed on the Mac"]);
  const committed = (await git(mirror, ["rev-parse", "HEAD"])).stdout.trim();

  await rm(log, { force: true });
  await core.runs.send(core.runs.liveRunForThread(thread.id)!.id, "Keep going");
  await until(() => existsSync(log));
  expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()).toBe(committed);
  await until(() => existsSync(path.join(mirror, "second.txt")));
  await until(() => {
    const last = checkpoints.listForThread(core.db, thread.id).at(-1);
    return Boolean(last) && execFileSync("git", ["ls-tree", "--name-only", last!.treeSha], { cwd: mirror, encoding: "utf8" }).includes("second.txt");
  });
  expect((await git(mirror, ["rev-parse", "HEAD"])).stdout.trim()).toBe(committed);
  expect((await git(mirror, ["status", "--porcelain"])).stdout).toBe("?? second.txt\n");
  expect((await git(mirror, ["for-each-ref", `refs/openorc/cloud/${thread.id}/kept-commit/`])).stdout).toBe("");
});

it("signs the agent in to its sandbox with the thread's account token, and with none when the account has no token", async () => {
  const start = (prompt: string) =>
    core.threads.start({
      agent: "claude",
      model: "fixture",
      effort: undefined,
      mode: "act",
      permissionMode: "autonomous",
      attachments: undefined,
      title: undefined,
      projectId: project.id,
      prompt,
      cloud: true,
    });
  await start("Without a token");
  await until(() => existsSync(log));
  expect(JSON.parse(readFileSync(log, "utf8")).oauth).toBeNull();

  await rm(log, { force: true });
  await core.claudeCloudTokens.save(core.claudeAccounts.defaultId(), "sk-ant-oat01-Thread_account_token-0123456789");
  await start("With a token");
  await until(() => existsSync(log));
  expect(JSON.parse(readFileSync(log, "utf8")).oauth).toBe("sk-ant-oat01-Thread_account_token-0123456789");
});

it("opens a cloud thread at once and sends its first message when the sandbox is ready", async () => {
  const started = await core.threads.start({
    agent: "claude",
    model: "fixture",
    effort: undefined,
    mode: "act",
    permissionMode: "autonomous",
    attachments: undefined,
    title: undefined,
    projectId: project.id,
    prompt: "Work in the cloud",
    cloud: true,
  });
  expect(started.run).toBeNull();
  const opened = core.threads.get(started.thread.id)!;
  expect(opened.queued.map((message) => message.text)).toEqual(["Work in the cloud"]);
  expect(opened.cloud).toMatchObject({ provider: "local", state: "preparing" });

  await until(() => existsSync(log));
  await until(() => core.threads.get(started.thread.id)!.queued.length === 0);
  expect(core.threads.get(started.thread.id)!.cloud).toEqual({ provider: "local", state: "ready", step: null, setup: false, error: null });
});

it("shows a failed setup on the thread and finishes it when the message is sent again", async () => {
  core.projects.updateSettings(project.id, { setupScript: "echo 'pnpm: command not found' >&2; exit 127" });
  const { thread } = await core.threads.start({
    agent: "claude",
    model: "fixture",
    effort: undefined,
    mode: "act",
    permissionMode: "autonomous",
    attachments: undefined,
    title: undefined,
    projectId: project.id,
    prompt: "Work in the cloud",
    cloud: true,
  });
  await until(() => core.threads.get(thread.id)!.queued[0]?.interrupted === true);
  const failed = core.threads.get(thread.id)!;
  expect(failed.cloud).toMatchObject({ state: "failed", step: null, error: expect.stringContaining("pnpm: command not found") });
  expect(failed.queued[0]?.error).toContain("The setup script failed in the cloud workspace (exit 127).");
  expect(existsSync(log)).toBe(false);

  core.projects.updateSettings(project.id, { setupScript: "sleep 0.5" });
  const sent = core.threads.sendQueued(thread.id, failed.queued[0]!.id);
  await until(() => core.threads.get(thread.id)!.cloud?.step === "setup");
  expect(core.threads.get(thread.id)!.cloud).toMatchObject({ state: "preparing", error: null });
  await sent;
  await until(() => existsSync(log));
  expect(core.threads.get(thread.id)!.cloud).toMatchObject({ state: "ready", error: null });
});
