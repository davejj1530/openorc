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
const log = { cwd: process.cwd(), args };
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
  const sandboxes = new LocalSandboxProvider(path.join(root, "sandboxes"), () => ({ ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, FAKE_CLAUDE_LOG: log }));
  core = await OpenOrc.create({ dataDir: path.join(root, "data"), ephemeral: true, transport: { push: () => {} }, cloudSandboxes: sandboxes });
  settings.set(core.db, "extraction.provider", "off");
  vi.spyOn(core.textGeneration, "title").mockResolvedValue(null);
  vi.spyOn(core.runs, "models").mockResolvedValue([{ id: "fixture", label: "Fixture", agent: "claude", isDefault: true, efforts: ["high"], defaultEffort: "high", fastMode: { supported: false } }]);
  project = await core.projects.import(checkout);
});

afterEach(async () => {
  await core.close();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

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
  const mirror = core.threads.get(thread.id)!.worktreePath!;
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
  const mirror = core.threads.get(thread.id)!.worktreePath!;
  await until(() => existsSync(path.join(mirror, "progress.txt")), 15_000);
  expect(existsSync(log)).toBe(false);
  await until(() => existsSync(path.join(mirror, "made-in-cloud.txt")), 15_000);
}, 40_000);

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
