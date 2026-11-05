import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, expect, it } from "vitest";
import { hostHome } from "../host-home.js";
import { SessionRefused, type SavedSession, type SessionId } from "../session-slot.js";
import { codexSlot } from "./session-slot.js";

const PARENT = "01a1a774-c00a-7931-a22c-485fea3d13dc";
const FORK = "01a1a775-38df-7bc0-973e-acc74e9d0d66";
const CHILD = "01a1a776-0000-7000-8000-000000000001";
const DAY = "sessions/2026/11/05";
const file = (id: string, at = "00-46-48") => `${DAY}/rollout-2026-11-05T${at}-${id}.jsonl`;
const meta = (id: string, extra: object = {}) => `${JSON.stringify({ ordinal: 0, type: "session_meta", payload: { id, cwd: "/Users/me/app", history_mode: "paginated", ...extra } })}\n`;
const record = (text: string) => `${JSON.stringify({ type: "response_item", payload: { text } })}\n`;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-codex-slot-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const home = (name: string) => hostHome({ agent: "codex", userHome: root, env: { CODEX_HOME: path.join(root, name) }, binary: "codex", processEnv: {} });
const ref = (sessionId: string, children: string[] = []) => ({ sessionId: sessionId as SessionId, cwd: "/w", children });
async function put(name: string, rollouts: Record<string, string | Buffer>): Promise<void> {
  for (const [relative, bytes] of Object.entries(rollouts)) {
    await mkdir(path.dirname(path.join(root, name, relative)), { recursive: true });
    await writeFile(path.join(root, name, relative), bytes);
  }
}
const fork = () => meta(FORK, { history_base: { thread_id: PARENT, end_ordinal_exclusive: 2, end_byte_offset: 177 } }) + record("Forked");

it("moves a paginated fork with the rollout it builds on, byte for byte, there and back", async () => {
  const parent = meta(PARENT) + record("Parent turn");
  await put("mac", { [file(PARENT)]: parent, [file(FORK, "00-47-19")]: fork(), [file("unrelated-thread")]: meta("unrelated-thread") });
  const saved = await codexSlot.export(home("mac"), ref(FORK));
  expect(saved?.parts.map((part) => part.name)).toEqual([file(FORK, "00-47-19"), file(PARENT)]);
  expect(saved?.meta).toEqual({ selected: file(FORK, "00-47-19") });

  const digest = await codexSlot.import(home("sandbox"), saved!, "/vercel/sandbox/repo");
  const there = await codexSlot.export(home("sandbox"), ref(FORK));
  expect(codexSlot.digest(there!)).toBe(digest);
  await codexSlot.import(home("back"), there!, "/Users/me/app");
  expect(await readFile(path.join(root, "back", file(PARENT)), "utf8")).toBe(parent);
  expect(await readFile(path.join(root, "back", file(FORK, "00-47-19")), "utf8")).toBe(fork());
});

it("refuses, in words, a fork whose earlier rollout is not on this machine", async () => {
  await put("mac", { [file(FORK, "00-47-19")]: fork() });
  await expect(codexSlot.export(home("mac"), ref(FORK))).rejects.toThrow(new SessionRefused("This Codex conversation builds on an earlier one that is not on this machine, so it cannot move."));
});

it("follows a compressed or archived rollout it builds on, and takes its subagents' rollouts", async () => {
  await put("mac", {
    [`archived_sessions/rollout-2026-11-05T00-46-48-${PARENT}.jsonl.zst`]: zstdCompressSync(Buffer.from(meta(PARENT))),
    [file(FORK, "00-47-19")]: fork(),
    [file(CHILD, "00-50-00")]: meta(CHILD),
  });
  const saved = await codexSlot.export(home("mac"), ref(FORK, [CHILD, "a-child-never-saved"]));
  expect(saved?.parts.map((part) => part.name)).toEqual([file(FORK, "00-47-19"), `archived_sessions/rollout-2026-11-05T00-46-48-${PARENT}.jsonl.zst`, file(CHILD, "00-50-00")]);
});

it("refuses a history it does not know how to follow, and a compressed part it cannot read", async () => {
  await put("mac", { [file(PARENT)]: meta(PARENT, { history_mode: "sharded" }) });
  await expect(codexSlot.export(home("mac"), ref(PARENT))).rejects.toThrow("does not know: sharded");
  await put("other", { [`${DAY}/rollout-2026-11-05T00-46-48-${PARENT}.jsonl.zst`]: Buffer.from("not zstd") });
  await expect(codexSlot.export(home("other"), ref(PARENT))).rejects.toThrow("could not be read");
});

it("writes only rollouts in Codex's two session folders, checking every name before writing any", async () => {
  const saved = (name: string): SavedSession => ({
    agent: "codex",
    format: 1,
    cliVersion: null,
    sessionId: PARENT as SessionId,
    meta: { selected: file(PARENT) },
    parts: [
      { name: file(PARENT), bytes: Buffer.from(meta(PARENT)) },
      { name, bytes: Buffer.from("{}") },
    ],
  });
  for (const name of ["auth.json", "config.toml", "../outside.jsonl", `${DAY}/../../../auth.json`, "sessions/2026/11/05/nested/rollout-x.jsonl", "state_5.sqlite"])
    await expect(codexSlot.import(home("sandbox"), saved(name), "/w")).rejects.toThrow("cannot have");
  await expect(readFile(path.join(root, "sandbox", file(PARENT)))).rejects.toThrow();
  const unnamed = { ...saved(file(FORK)), meta: { selected: file(CHILD) } };
  await expect(codexSlot.import(home("sandbox"), unnamed, "/w")).rejects.toThrow("does not include the rollout it names");
});

it("continues a thread with codex exec, its sandbox standing in for the thread's permissions", () => {
  const run = codexSlot.continueOnce({ sessionId: PARENT as SessionId }, "Carry on", { model: "gpt-5", effort: "high", mode: "act", permissionMode: "trusted" });
  expect([run.cmd, ...run.args]).toEqual(["codex", "exec", "resume", "--json", "-c", 'sandbox_mode="workspace-write"', "-m", "gpt-5", "-c", 'model_reasoning_effort="high"', PARENT, "Carry on"]);
  expect(codexSlot.continueOnce({ sessionId: PARENT as SessionId }, "x", { model: null, effort: null, mode: "plan", permissionMode: "autonomous" }).args).toContain('sandbox_mode="read-only"');
});

/** Answers the check as Codex's app server would, resuming whichever thread id it is told to answer with. */
const APP_SERVER = `
const answer = process.argv[1];
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "thread/resume") process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: answer, path: message.params.path } } }) + "\\n");
  else if (message.id !== undefined) process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
});`;

it("proves a resume with the thread's own provider moved to an address nothing answers, the home's MCP servers off", async () => {
  await put("mac", { [file(PARENT)]: meta(PARENT, { model_provider: "openai" }), [file(FORK, "00-47-19")]: meta(FORK, { model_provider: "azure" }) });
  await writeFile(path.join(root, "mac", "config.toml"), '[mcp_servers.github]\ncommand = "gh"\n[mcp_servers."docs"]\nurl = "https://x"\n');
  const spawned: string[][] = [];
  const checking = (answer: string) => ({
    ...home("mac"),
    machine: "here" as const,
    spawn: (args: readonly string[]) => (spawned.push([...args]), spawn(process.execPath, ["-e", APP_SERVER, answer], { stdio: ["pipe", "pipe", "pipe"], detached: true })),
  });
  expect(await codexSlot.check(checking(PARENT), ref(PARENT))).toBeNull();
  expect(spawned[0]).toEqual([
    "app-server",
    "--listen",
    "stdio://",
    "-c",
    'model_provider="openai"',
    "-c",
    'openai_base_url="http://127.0.0.1:9/v1"',
    "-c",
    "mcp_servers.github.enabled=false",
    "-c",
    "mcp_servers.docs.enabled=false",
  ]);
  expect(await codexSlot.check(checking("someone-else"), ref(FORK))).toBe("Codex resumed another conversation than this one.");
  expect(spawned[1]).toContain('model_providers.azure.base_url="http://127.0.0.1:9/v1"');
  expect(await codexSlot.check(checking(PARENT), ref("not-here"))).toBe("Codex's conversation is not in its sessions folder here.");
});
