import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agent37Api, Agent37SandboxProvider, runnerFiles, startFakeAgent37, type FakeAgent37 } from "@openorc/cloud";
import { checkpoints, cloudWorkspaces, settings } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import type { Project } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";

/** Stands in for Claude Code inside the instance: records where it ran and what reached it, makes a file, answers one turn. */
const FAKE_CLAUDE = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import readline from "node:readline";
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("2.1.316 (Claude Code)");
  process.exit(0);
}
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const prompt = JSON.parse(line).message.content[0].text;
  const url = Object.values(JSON.parse((await import("node:fs")).readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8")).mcpServers)[0].url;
  const mcp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } }),
  });
  writeFileSync("made-on-agent37.txt", "hello\\n");
  writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ cwd: process.cwd(), prompt, mcpStatus: mcp.status, token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null }));
  emit({ type: "system", subtype: "init", session_id: "agent37-session", model: "fixture", tools: [] });
  emit({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Done on Agent37" }], usage: { input_tokens: 1, output_tokens: 1 } } });
  emit({ type: "result", subtype: "success", is_error: false, duration_ms: 5, num_turns: 1, total_cost_usd: 0, result: "Done on Agent37", usage: { input_tokens: 1, output_tokens: 1 } });
});
`;

let root: string;
let fake: FakeAgent37;
let core: OpenOrc;
let project: Project;
let log: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-agent37-runs-")));
  const checkout = path.join(root, "app");
  await mkdir(checkout);
  await git(checkout, ["init", "-q", "-b", "main"]);
  await git(checkout, ["config", "user.email", "fixture@example.com"]);
  await git(checkout, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(checkout, "README.md"), "# Agent37 fixture\n");
  await commitAll(checkout, "Fixture baseline");
  // The fake CLI is only on the instance's PATH, so a run that finds it ran in the instance.
  const bin = path.join(root, "instance-bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "claude"), FAKE_CLAUDE);
  await chmod(path.join(bin, "claude"), 0o755);
  log = path.join(root, "fake-claude.json");
  fake = await startFakeAgent37(path.join(root, "instances"), { env: () => ({ ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, FAKE_CLAUDE_LOG: log }) });
  const provider = new Agent37SandboxProvider({ credentials: async () => ({ key: fake.key, cpu: 2, memory: 4 }), files: runnerFiles(), api: (key) => agent37Api(key, fake.endpoints) });
  let saved: string | null = null;
  const tokenStore = { load: async () => saved, save: async (value: string) => void (saved = value) };
  // This host's Claude is the instance's own stand-in, so its version is the one wanted there: an instance here runs
  // its commands on this machine, where a version of its own would install a real Claude.
  const shellProbe = async () => ({ path: process.env["PATH"] ?? "", binaries: { claude: path.join(bin, "claude"), codex: null, opencode: null } });
  core = await OpenOrc.create({ dataDir: path.join(root, "data"), ephemeral: true, transport: { push: () => {} }, cloudSandboxes: provider, claudeCloudSecrets: tokenStore, shellProbe });
  settings.set(core.db, "extraction.provider", "off");
  vi.spyOn(core.textGeneration, "title").mockResolvedValue(null);
  vi.spyOn(core.runs, "models").mockResolvedValue([{ id: "fixture", label: "Fixture", agent: "claude", isDefault: true, efforts: ["high"], defaultEffort: "high", fastMode: { supported: false } }]);
  project = await core.projects.import(checkout);
  await core.claudeCloudTokens.save(core.claudeAccounts.defaultId(), "sk-ant-oat01-Agent37_account_token-0123456789");
});

afterEach(async () => {
  await core.close();
  await fake.close();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function until(check: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

it("runs a cloud conversation's turn in an Agent37 instance, reaching OpenOrc's tools, and brings its files to the Mac", async () => {
  const { thread } = await core.threads.start({
    agent: "claude",
    model: "fixture",
    effort: undefined,
    mode: "act",
    permissionMode: "trusted",
    attachments: [],
    title: undefined,
    projectId: project.id,
    prompt: "Work on Agent37",
    cloud: true,
  });
  await until(() => existsSync(log));
  const ran = JSON.parse(readFileSync(log, "utf8")) as { cwd: string; prompt: string; mcpStatus: number; token: string | null };
  expect(ran.cwd.startsWith(path.join(root, "instances"))).toBe(true);
  expect(ran.prompt).toContain("Work on Agent37");
  expect(ran.mcpStatus).toBe(200);
  // Agent37 cannot add a sign-in on the way out, so the instance holds the account's token.
  expect(ran.token).toBe("sk-ant-oat01-Agent37_account_token-0123456789");
  expect(cloudWorkspaces.get(core.db, thread.id)?.provider).toBe("agent37");

  await until(() => Boolean(core.threads.get(thread.id)?.worktreePath));
  const mirror = core.threads.get(thread.id)!.worktreePath!;
  await until(() => checkpoints.listForThread(core.db, thread.id).length > 0 && existsSync(path.join(mirror, "made-on-agent37.txt")));
  expect(readFileSync(path.join(mirror, "made-on-agent37.txt"), "utf8")).toBe("hello\n");
  expect(fake.execs.some((exec) => exec.command.includes("instance-server.ts"))).toBe(true);
}, 60_000);
