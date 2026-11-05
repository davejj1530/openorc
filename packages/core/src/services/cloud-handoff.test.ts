import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalSandboxProvider } from "@openorc/cloud";
import { settings } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import type { Project } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { claudeSessionFile } from "@openorc/agents";
import { inheritedProbe } from "./shell-environment.js";

/**
 * Stands in for Claude Code on this Mac and in the sandbox. Like the CLI, it keeps each session in its config folder
 * under the folder it runs in, and refuses to resume a session that is not there. Each turn appends to FAKE_LOG.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("2.1.316 (Claude Code)");
  process.exit(0);
}
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const resume = flag("--resume");
const id = resume ?? flag("--session-id") ?? "fresh-session";
const config = process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME, ".claude");
const file = path.join(config, "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"), id + ".jsonl");
if (resume && !existsSync(file)) {
  console.error("No conversation found with session ID: " + resume);
  process.exit(1);
}
const earlier = existsSync(file) ? readFileSync(file, "utf8").trim().split("\\n").length : 0;
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const prompt = JSON.parse(line).message.content[0].text;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ type: "user", cwd: process.cwd(), sessionId: id, prompt }) + "\\n");
  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cwd: process.cwd(), id, resumed: Boolean(resume), earlier, prompt }) + "\\n");
  emit({ type: "system", subtype: "init", session_id: id, model: "fixture", tools: [] });
  emit({ type: "assistant", message: { id: "m-" + Date.now(), role: "assistant", content: [{ type: "text", text: "Done" }], usage: { input_tokens: 1, output_tokens: 1 } } });
  emit({ type: "result", subtype: "success", is_error: false, duration_ms: 5, num_turns: 1, total_cost_usd: 0, result: "Done", usage: { input_tokens: 1, output_tokens: 1 } });
});
`;

let root: string;
let config: string;
let log: string;
let core: OpenOrc;
let project: Project;

interface Turn {
  cwd: string;
  id: string;
  resumed: boolean;
  earlier: number;
  prompt: string;
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
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-cloud-handoff-")));
  const checkout = path.join(root, "app");
  await mkdir(checkout);
  await git(checkout, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(checkout, "README.md"), "# Handoff fixture\n");
  await commitAll(checkout, "Fixture baseline");
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "claude"), FAKE_CLAUDE);
  await chmod(path.join(bin, "claude"), 0o755);
  config = path.join(root, "claude-config");
  log = path.join(root, "turns.jsonl");
  // Every Claude here, on this Mac or in the sandbox, is the fake, with a config folder of the test's own.
  const env = { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, CLAUDE_CONFIG_DIR: config, FAKE_LOG: log, OPENORC_CLAUDE_BIN: path.join(bin, "claude") };
  vi.stubEnv("CLAUDE_CONFIG_DIR", config);
  vi.stubEnv("FAKE_LOG", log);
  const sandboxes = new LocalSandboxProvider(path.join(root, "sandboxes"), () => env, 1500);
  core = await OpenOrc.create({ dataDir: path.join(root, "data"), ephemeral: true, transport: { push: () => {} }, shellProbe: inheritedProbe(env), cloudSandboxes: sandboxes });
  settings.set(core.db, "extraction.provider", "off");
  vi.spyOn(core.textGeneration, "title").mockResolvedValue(null);
  vi.spyOn(core.runs, "models").mockResolvedValue([{ id: "fixture", label: "Fixture", agent: "claude", isDefault: true, efforts: ["high"], defaultEffort: "high", fastMode: { supported: false } }]);
  project = await core.projects.import(checkout);
});

afterEach(async () => {
  await core.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const turn = { agent: "claude", model: "fixture", effort: undefined, mode: "act", permissionMode: "autonomous", attachments: undefined } as const;

it("moves a conversation that ran on this Mac to a sandbox, where Claude resumes its session, and keeps it through a new sandbox", async () => {
  const { thread } = await core.threads.start({ ...turn, title: "Handoff", projectId: project.id, prompt: "Start here", workspaceMode: "worktree" });
  await until(() => turns().length === 1 && core.runs.threadActivity(thread.id) === "idle");
  const worktree = core.threads.get(thread.id)!.worktreePath!;
  const [local] = turns();
  expect(local).toMatchObject({ cwd: worktree, resumed: false });

  const sessionId = local!.id;
  await core.cloudHandoff.move(thread.id);
  expect(core.runs.liveRunForThread(thread.id)).toBeNull();
  await until(() => core.threads.get(thread.id)!.cloud?.state === "ready");
  const repo = path.join(root, "sandboxes", `openorc-${thread.id}`, "repo");
  const sent = readFileSync(claudeSessionFile(config, repo, sessionId), "utf8");
  expect(sent).toContain(`"cwd":"${repo}"`);
  expect(sent).not.toContain(worktree);

  await core.threads.continueThread(thread.id, { ...turn, prompt: "Keep going" });
  await until(() => turns().length === 2 && core.runs.threadActivity(thread.id) === "idle");
  expect(turns()[1]).toMatchObject({ cwd: repo, id: sessionId, resumed: true, earlier: 1 });
  // The turn's end brings the session back to this Mac, where Claude would resume it in the worktree.
  await until(() => readFileSync(claudeSessionFile(config, worktree, sessionId), "utf8").includes("Keep going"));
  expect(readFileSync(claudeSessionFile(config, worktree, sessionId), "utf8")).not.toContain(repo);

  await core.cloudSandboxes.remove(`openorc-${thread.id}`);
  await core.threads.continueThread(thread.id, { ...turn, prompt: "Once more" });
  await until(() => turns().length === 3);
  expect(turns()[2]).toMatchObject({ cwd: repo, id: sessionId, resumed: true, earlier: 2 });
}, 60_000);

it("refuses to move a conversation whose agent is at work, or one already in the cloud, changing nothing", async () => {
  const { thread } = await core.threads.start({ ...turn, title: "Busy", projectId: project.id, prompt: "Start here", workspaceMode: "worktree" });
  await until(() => turns().length === 1 && core.runs.threadActivity(thread.id) === "idle");
  vi.spyOn(core.runs, "threadActivity").mockReturnValueOnce("running");
  await expect(core.cloudHandoff.move(thread.id)).rejects.toThrow("Its agent is at work.");
  expect(core.threads.get(thread.id)!.cloud).toBeNull();
  await core.cloudHandoff.move(thread.id);
  await expect(core.cloudHandoff.move(thread.id)).rejects.toThrow("already runs in the cloud");
  await until(() => core.threads.get(thread.id)!.cloud?.state === "ready");
}, 40_000);
