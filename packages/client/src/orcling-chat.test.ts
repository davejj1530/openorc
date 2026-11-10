import { expect, it } from "vitest";
import type { Block } from "./transcript.js";
import { CHAT_STRETCH_MS, chatRows } from "./orcling-chat.js";

const message = (id: string, role: "user" | "assistant" | "system", text: string, at: number, streaming = false): Block => ({ id, kind: "message", role, text, streaming, at, runId: "run" });

it("shows what was said and what needs the person, and leaves the Orcling's work out of sight", () => {
  const rows = chatRows([
    message("u1", "user", "why is CI slow?", 1000),
    { id: "think", kind: "thinking", text: "hmm", startedAt: 1000, endedAt: 1100 },
    message("a1", "assistant", "on it", 1200),
    { id: "tool", kind: "tool", name: "orcling_project", input: {}, done: true },
    { id: "ask", kind: "approval", approvalId: "x", approvalKind: "command", input: {} },
    message("a2", "assistant", "found it.\n\nthe cache key skipped the branch", 1300),
    { id: "status", kind: "status", text: "turn finished", tone: "ok" },
    message("a3", "assistant", "still typi", 1400, true),
  ]);
  expect(rows.map((row) => (row.kind === "theirs" ? `${row.kind}:${row.bubbles.join("|")}` : `${row.kind}:${row.id}`))).toEqual([
    "time:time-u1",
    "mine:u1",
    "theirs:on it",
    "card:ask",
    "theirs:found it.|the cache key skipped the branch",
  ]);
});

it("heads each stretch of the chat with its time", () => {
  const rows = chatRows([message("u1", "user", "hi", 0), message("a1", "assistant", "hey", 1000), message("u2", "user", "back", CHAT_STRETCH_MS + 1000)]);
  expect(rows.filter((row) => row.kind === "time").map((row) => row.id)).toEqual(["time-u1", "time-u2"]);
});

it("shows what the Orcling drew for the person, while its other tool calls stay out of sight", () => {
  const drawn = {
    id: "v1",
    kind: "tool",
    name: "mcp__openorc__visualize",
    input: { title: "Sign-in flow", description: "Mac sign-in, step by step.", html: "<p>steps</p>" },
    done: true,
    status: "success",
    at: 3,
    runId: "run",
  } as Block;
  const read = { id: "r1", kind: "tool", name: "Read", input: { file_path: "a.ts" }, done: true, status: "success", at: 2, runId: "run" } as Block;
  const rows = chatRows([message("u1", "user", "can you show me?", 1), read, drawn, message("a1", "assistant", "here it is", 4)]);
  expect(rows.map((row) => row.kind)).toEqual(["time", "mine", "visualization", "theirs"]);
  expect(rows[2]).toMatchObject({ kind: "visualization", visualization: { title: "Sign-in flow" } });
});
