import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claudeProjectDir, listClaudeSessions, listCodexSessions, readClaudeSession, readCodexSession } from "./import.js";

let home: string;
const cwd = "/Users/someone/dev/demo";

const claudeLines = [
  { type: "queue-operation", operation: "enqueue" },
  { type: "user", isSidechain: false, sessionId: "s-claude", cwd, timestamp: "2026-09-01T10:00:00.000Z", uuid: "u1", message: { role: "user", content: "Add pagination to the invoices table" } },
  {
    type: "assistant",
    sessionId: "s-claude",
    timestamp: "2026-09-01T10:00:05.000Z",
    uuid: "a1",
    message: {
      id: "msg1",
      content: [
        { type: "text", text: "Looking at the table." },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "invoices.ts" } },
      ],
    },
  },
  {
    type: "user",
    sessionId: "s-claude",
    timestamp: "2026-09-01T10:00:06.000Z",
    uuid: "u2",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "export const x = 1" }] },
  },
  { type: "user", isMeta: true, sessionId: "s-claude", timestamp: "2026-09-01T10:00:07.000Z", uuid: "u3", message: { role: "user", content: "<command-name>/clear</command-name>" } },
  { type: "assistant", sessionId: "s-claude", timestamp: "2026-09-01T10:00:09.000Z", uuid: "a2", message: { id: "msg2", content: [{ type: "text", text: "Done: cursor pagination added." }] } },
];

const codexLines = [
  { timestamp: "2026-09-02T09:00:00.000Z", type: "session_meta", payload: { id: "s-codex", cwd, timestamp: "2026-09-02T09:00:00.000Z" } },
  { timestamp: "2026-09-02T09:00:01.000Z", type: "response_item", payload: { type: "message", id: "d1", role: "developer", content: [{ type: "input_text", text: "You are Codex." }] } },
  {
    timestamp: "2026-09-02T09:00:01.000Z",
    type: "response_item",
    payload: { type: "message", id: "u0", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] },
  },
  { timestamp: "2026-09-02T09:00:02.000Z", type: "response_item", payload: { type: "message", id: "u1", role: "user", content: [{ type: "input_text", text: "Rename the export button" }] } },
  { timestamp: "2026-09-02T09:00:03.000Z", type: "response_item", payload: { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "Find the button." }] } },
  { timestamp: "2026-09-02T09:00:04.000Z", type: "response_item", payload: { type: "function_call", id: "f1", call_id: "c1", name: "shell", arguments: '{"command":["rg","Export"]}' } },
  { timestamp: "2026-09-02T09:00:05.000Z", type: "response_item", payload: { type: "function_call_output", id: "f2", call_id: "c1", output: "src/Button.tsx" } },
  { timestamp: "2026-09-02T09:00:06.000Z", type: "response_item", payload: { type: "message", id: "a1", role: "assistant", content: [{ type: "output_text", text: "Renamed it to Download." }] } },
];

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "openorc-import-"));
  const claudeDir = claudeProjectDir(cwd, home);
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(claudeDir, "s-claude.jsonl"), claudeLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  await writeFile(
    path.join(claudeDir, "other.jsonl"),
    JSON.stringify({ type: "user", sessionId: "s-other", cwd: "/elsewhere", timestamp: "2026-09-01T10:00:00.000Z", message: { role: "user", content: "hi" } }) + "\n",
  );
  const codexDir = path.join(home, ".codex", "sessions", "2026", "09", "02");
  await mkdir(codexDir, { recursive: true });
  await writeFile(path.join(codexDir, "rollout-1.jsonl"), codexLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  await writeFile(path.join(codexDir, "rollout-2.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "s-x", cwd: "/elsewhere" } }) + "\n");
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("import", () => {
  it("reads a Claude transcript into events, skipping meta lines and tool results' user rows", async () => {
    const [file] = await listClaudeSessions(cwd, home);
    const session = await readClaudeSession(file?.path as string, "run-1", cwd);
    expect(session?.events.map((e) => e.type)).toEqual([
      "session.started",
      "message.completed",
      "message.completed",
      "tool.started",
      "tool.completed",
      "message.completed",
      "turn.completed",
      "session.completed",
    ]);
    expect(session?.lastReply).toBe("Done: cursor pagination added.");
    const tool = session?.events.find((e) => e.type === "tool.completed");
    expect(tool && tool.type === "tool.completed" && tool.name).toBe("Read");
  });

  it("lists and reads Codex rollouts, dropping developer and injected user messages", async () => {
    const list = await listCodexSessions(cwd, home);
    expect(list.map((s) => s.sessionId)).toEqual(["s-codex"]);
    expect(list[0]?.title).toBe("Rename the export button");
    const session = await readCodexSession(list[0]?.path as string, "run-2", cwd);
    expect(session?.events.map((e) => e.type)).toEqual([
      "session.started",
      "message.completed",
      "thinking.delta",
      "tool.started",
      "tool.completed",
      "message.completed",
      "turn.completed",
      "session.completed",
    ]);
    const call = session?.events.find((e) => e.type === "tool.started");
    expect(call && call.type === "tool.started" && call.input).toEqual({ command: ["rg", "Export"] });
    expect(session?.lastReply).toBe("Renamed it to Download.");
  });

  it("skips malformed records and retains later valid nested Claude and Codex content", async () => {
    const fixtureHome = await mkdtemp(path.join(os.tmpdir(), "openorc-import-malformed-"));
    try {
      const claudeDir = claudeProjectDir(cwd, fixtureHome);
      await mkdir(claudeDir, { recursive: true });
      const claudeFile = path.join(claudeDir, "recovered.jsonl");
      await writeFile(
        claudeFile,
        [
          null,
          [],
          { type: "user", sessionId: "recovered-claude", cwd, timestamp: "2026-09-03T10:00:00Z", message: { content: [null, { type: "text", text: "Keep this user request" }] } },
          {
            type: "assistant",
            sessionId: "recovered-claude",
            timestamp: "2026-09-03T10:00:01Z",
            message: { id: "reply", content: [null, { type: "text", text: "Keep this reply" }, { type: "tool_use", id: "read-1", name: "Read", input: {} }] },
          },
          { type: "user", sessionId: "recovered-claude", timestamp: "2026-09-03T10:00:02Z", message: { content: [null, { type: "tool_result", tool_use_id: "read-1", content: "file content" }] } },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n") + "\n",
      );
      const claude = await readClaudeSession(claudeFile, "recovered-claude-run", cwd);
      expect(claude?.events).toContainEqual(expect.objectContaining({ type: "message.completed", text: "Keep this user request" }));
      expect(claude?.events).toContainEqual(expect.objectContaining({ type: "message.completed", text: "Keep this reply" }));
      expect(claude?.events).toContainEqual(expect.objectContaining({ type: "tool.completed", toolCallId: "read-1", output: "file content" }));

      const codexFile = path.join(fixtureHome, "rollout-recovered.jsonl");
      await writeFile(
        codexFile,
        [
          null,
          { type: "session_meta", timestamp: "2026-09-04T10:00:00Z", payload: { id: "recovered-codex", cwd } },
          { type: "response_item", timestamp: "2026-09-04T10:00:01Z", payload: null },
          { type: "response_item", timestamp: "2026-09-04T10:00:02Z", payload: { type: "message", role: "user", content: [null, { type: "input_text", text: "Keep this Codex request" }] } },
          { type: "response_item", timestamp: "2026-09-04T10:00:03Z", payload: { type: "reasoning", summary: [null, { text: "Reasoning survives" }] } },
          { type: "response_item", timestamp: "2026-09-04T10:00:04Z", payload: { type: "message", role: "assistant", content: [null, { type: "output_text", text: "Keep this Codex reply" }] } },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n") + "\n",
      );
      const codex = await readCodexSession(codexFile, "recovered-codex-run", cwd);
      expect(codex?.events).toContainEqual(expect.objectContaining({ type: "message.completed", text: "Keep this Codex request" }));
      expect(codex?.events).toContainEqual(expect.objectContaining({ type: "thinking.delta", text: "Reasoning survives" }));
      expect(codex?.lastReply).toBe("Keep this Codex reply");
    } finally {
      await rm(fixtureHome, { recursive: true, force: true });
    }
  });
});
