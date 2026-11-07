import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { hostHome } from "../host-home.js";
import type { SessionId } from "../session-slot.js";
import { claudeSessionFile, claudeSlot } from "./session-slot.js";

const ID = "0b9f3c3e-5d2a-4f1e-9c47-2a6f0d8e1b55" as SessionId;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-claude-slot-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const home = (config: string) => hostHome({ agent: "claude", userHome: root, env: { CLAUDE_CONFIG_DIR: config }, binary: "claude", processEnv: {} });
const line = (cwd: string, text: string) => `${JSON.stringify({ type: "user", cwd, sessionId: ID, text })}\n`;

it("never names a session file outside the folder Claude keeps the worktree's sessions in", () => {
  expect(claudeSessionFile("/Users/me/.claude", "/w", ID)).toBe(`/Users/me/.claude/projects/-w/${ID}.jsonl`);
  for (const sessionId of ["../-Users-me-dev-other/2f1c-victim-session", "a/b", "..", ""]) expect(() => claudeSessionFile("/Users/me/.claude", "/w", sessionId)).toThrow();
});

it("moves a session with its subagents to another folder, and an export there reads what the import said", async () => {
  const mac = path.join(root, "mac");
  const transcript = claudeSessionFile(mac, "/Users/me/app", ID);
  await mkdir(path.join(transcript.slice(0, -6), "subagents", "workflows", "wf-1"), { recursive: true });
  await writeFile(transcript, line("/Users/me/app", "Start"));
  await writeFile(path.join(transcript.slice(0, -6), "subagents", "agent-a1.jsonl"), line("/Users/me/app", "Look around"));
  await writeFile(path.join(transcript.slice(0, -6), "subagents", "workflows", "wf-1", "agent-b2.jsonl"), line("/Users/me/app", "Step"));

  const saved = await claudeSlot.export(home(mac), { sessionId: ID, cwd: "/Users/me/app", children: [] });
  expect(saved?.parts.map((part) => part.name)).toEqual(["session.jsonl", "subagents/agent-a1.jsonl", "subagents/workflows/wf-1/agent-b2.jsonl"]);

  const sandbox = home(path.join(root, "sandbox"));
  const stale = claudeSessionFile(path.join(root, "sandbox"), "/vercel/sandbox/repo", ID).slice(0, -6);
  await mkdir(path.join(stale, "subagents"), { recursive: true });
  await writeFile(path.join(stale, "subagents", "agent-gone.jsonl"), "old\n");

  const digest = await claudeSlot.import(sandbox, saved!, "/vercel/sandbox/repo");
  const there = await claudeSlot.export(sandbox, { sessionId: ID, cwd: "/vercel/sandbox/repo", children: [] });
  expect(claudeSlot.digest(there!)).toBe(digest);
  expect(there!.parts.map((part) => part.name)).toEqual(saved!.parts.map((part) => part.name));
  expect(there!.parts.map((part) => part.bytes.toString())).toEqual(saved!.parts.map((part) => part.bytes.toString().replaceAll("/Users/me/app", "/vercel/sandbox/repo")));
  expect(await claudeSlot.check(sandbox, { sessionId: ID, cwd: "/vercel/sandbox/repo", children: [] })).toBeNull();
});

it("refuses a part whose name would land outside the session's folder, before writing anything", async () => {
  const sandbox = home(path.join(root, "sandbox"));
  for (const name of ["../../escape.jsonl", "subagents/../../escape.jsonl", "/etc/passwd", "notes.txt"]) {
    const saved = {
      agent: "claude" as const,
      format: 1,
      cliVersion: null,
      sessionId: ID,
      meta: {},
      parts: [
        { name: "session.jsonl", bytes: Buffer.from(line("/a", "x")) },
        { name, bytes: Buffer.from("x") },
      ],
    };
    await expect(claudeSlot.import(sandbox, saved, "/vercel/sandbox/repo")).rejects.toThrow("cannot have");
  }
  await expect(readFile(claudeSessionFile(path.join(root, "sandbox"), "/vercel/sandbox/repo", ID))).rejects.toThrow();
});

it("says why a transcript cannot be resumed: missing, cut short, or another session's", async () => {
  const config = path.join(root, "c");
  const ref = { sessionId: ID, cwd: "/w", children: [] };
  expect(await claudeSlot.check(home(config), ref)).toContain("not where Claude Code looks");
  const file = claudeSessionFile(config, "/w", ID);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, line("/w", "x").trimEnd());
  expect(await claudeSlot.check(home(config), ref)).toContain("partway through a line");
  await writeFile(file, '{"sessionId":"other"}\n');
  expect(await claudeSlot.check(home(config), ref)).toContain("does not name its own session");
});

it("continues a session in one headless process, its permissions from the thread", () => {
  const run = claudeSlot.continueOnce({ sessionId: ID }, "Carry on", { model: "opus", effort: "high", mode: "plan", permissionMode: "autonomous" });
  expect(run.cmd).toBe("claude");
  expect(run.args).toEqual(["-p", "Carry on", "--output-format", "stream-json", "--verbose", "--resume", ID, "--permission-mode", "plan", "--model", "opus", "--effort", "high"]);
});
