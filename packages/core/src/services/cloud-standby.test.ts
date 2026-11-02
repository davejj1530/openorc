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
 * Stands in for Claude Code on this Mac and in the sandbox, keeping sessions like the CLI. Given its prompt in its
 * arguments, as a takeover is, it answers once and exits; otherwise it reads prompts from its input, and one that says
 * "slowly" keeps working until it is interrupted. Each turn appends to FAKE_LOG.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const answer = (prompt, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ type: "user", cwd: process.cwd(), sessionId: id, prompt }) + "\\n");
  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cwd: process.cwd(), id, prompt, permission: flag("--permission-mode") }) + "\\n");
  emit({ type: "system", subtype: "init", session_id: id, model: "fixture", tools: [] });
  emit({ type: "assistant", message: { id: "m-" + Date.now(), role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } } });
  emit({ type: "result", subtype: "success", is_error: false, duration_ms: 5, num_turns: 1, total_cost_usd: 0, result: text, usage: { input_tokens: 1, output_tokens: 1 } });
};
if (args.includes("-p") && !args.includes("--input-format")) {
  writeFileSync("carried-on.txt", "done in the cloud\\n");
  answer(flag("-p"), "Carried on in the cloud");
  process.exit(0);
}
let working = null;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const input = JSON.parse(line);
  if (input.type === "control_request") {
    if (input.request?.subtype === "interrupt" && working) {
      clearTimeout(working);
      working = null;
      answer("interrupted", "Stopped");
    }
    return;
  }
  const prompt = input.message.content[0].text;
  if (!prompt.includes("slowly")) return answer(prompt, "Done");
  writeFileSync("started-here.txt", "begun on the Mac\\n");
  working = setTimeout(() => answer(prompt, "Done slowly"), 60_000);
});
`;

let root: string;
let log: string;
let core: OpenOrc;
let project: Project;

interface Turn {
  cwd: string;
  id: string;
  prompt: string;
  permission: string | null;
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
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-cloud-standby-")));
  const checkout = path.join(root, "app");
  await mkdir(checkout);
  await git(checkout, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(checkout, "README.md"), "# Standby fixture\n");
  await commitAll(checkout, "Fixture baseline");
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "claude"), FAKE_CLAUDE);
  await chmod(path.join(bin, "claude"), 0o755);
  const config = path.join(root, "claude-config");
  log = path.join(root, "turns.jsonl");
  const env = { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, CLAUDE_CONFIG_DIR: config, FAKE_LOG: log, OPENORC_CLAUDE_BIN: path.join(bin, "claude") };
  vi.stubEnv("CLAUDE_CONFIG_DIR", config);
  vi.stubEnv("FAKE_LOG", log);
  const sandboxes = new LocalSandboxProvider(path.join(root, "sandboxes"), () => env, 1500);
  let saved: string | null = null;
  const store = { load: async () => saved, save: async (value: string) => void (saved = value) };
  core = await OpenOrc.create({ dataDir: path.join(root, "data"), ephemeral: true, transport: { push: () => {} }, shellProbe: inheritedProbe(env), cloudSandboxes: sandboxes, cloudSecrets: store });
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

const turn = { agent: "claude", model: "fixture", effort: undefined, mode: "act", permissionMode: "trusted", attachments: undefined } as const;
/** Peeks at whether the standby is armed with the conversation's session. */
const armedWith = (threadId: string) => (core.cloudStandby as unknown as { standbys: Map<string, { turn: { sessionId: string | null } | null }> }).standbys.get(threadId)?.turn?.sessionId ?? null;

it("carries a turn on in the cloud when this Mac goes to sleep, and brings it into the conversation when the Mac wakes", async () => {
  await core.cloudSettings.setTakeover(true);
  const { thread } = await core.threads.start({ ...turn, title: "Takeover", projectId: project.id, prompt: "Start here", workspaceMode: "worktree" });
  await until(() => turns().length === 1 && core.runs.threadActivity(thread.id) === "idle");
  const sessionId = turns()[0]!.id;
  const worktree = core.threads.get(thread.id)!.worktreePath!;

  await core.threads.continueThread(thread.id, { ...turn, prompt: "Work slowly" });
  await until(() => existsSync(path.join(worktree, "started-here.txt")) && armedWith(thread.id) === sessionId);
  // The standby has the work so far: the file the turn made on this Mac is in the sandbox too.
  const repo = path.join(root, "sandboxes", `openorc-${thread.id}`, "repo");
  await until(() => existsSync(path.join(repo, "started-here.txt")));

  await core.cloudStandby.away();
  await until(() => turns().some((entry) => entry.cwd === repo));
  const takeover = turns().find((entry) => entry.cwd === repo)!;
  expect(takeover).toMatchObject({ id: sessionId, permission: "acceptEdits" });
  expect(takeover.prompt).toContain("This Mac went to sleep");

  await core.cloudStandby.back();
  expect(core.threads.get(thread.id)!.cloud).toMatchObject({ provider: "local", state: "ready" });
  expect(core.runs.liveRunForThread(thread.id)).toBeNull();
  // What the sandbox did reaches the worktree, and its turn is in the conversation.
  await until(() => existsSync(path.join(worktree, "carried-on.txt")));
  const last = runs.listForThread(core.db, thread.id).at(-1)!;
  expect(last).toMatchObject({ state: "success", externalSessionId: sessionId, resultText: "Carried on in the cloud" });
  expect(core.threads.messages(thread.id).map((message) => message.text)).toContain("This Mac went to sleep, so the turn carried on in the cloud.");

  // The conversation goes on in the cloud from there.
  await core.threads.continueThread(thread.id, { ...turn, prompt: "And then" });
  await until(() => turns().at(-1)?.prompt.startsWith("And then") === true);
  // Its prompt is the message alone: the takeover's files are the agent's own work, not changes made outside its turns.
  expect(turns().at(-1)).toMatchObject({ cwd: repo, id: sessionId, prompt: "And then" });
}, 90_000);

it("leaves turns on this Mac alone while the setting is off", async () => {
  const { thread } = await core.threads.start({ ...turn, title: "Stays", projectId: project.id, prompt: "Start here", workspaceMode: "worktree" });
  await until(() => turns().length === 1 && core.runs.threadActivity(thread.id) === "idle");
  await core.threads.continueThread(thread.id, { ...turn, prompt: "Work slowly" });
  const worktree = core.threads.get(thread.id)!.worktreePath!;
  await until(() => existsSync(path.join(worktree, "started-here.txt")));
  await core.cloudStandby.away();
  await core.cloudStandby.back();
  expect(existsSync(path.join(root, "sandboxes"))).toBe(false);
  expect(core.threads.get(thread.id)!.cloud).toBeNull();
  expect(core.runs.threadActivity(thread.id)).toBe("running");
}, 40_000);
