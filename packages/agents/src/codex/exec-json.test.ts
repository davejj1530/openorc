import { expect, it } from "vitest";
import { CodexExecParser } from "./exec-json.js";

const lines = [
  { type: "thread.started", thread_id: "019a-thread" },
  { type: "turn.started" },
  { type: "item.started", item: { id: "c1", type: "command_execution", command: "npm test", status: "in_progress" } },
  { type: "item.completed", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "ok\n", exit_code: 0, status: "completed" } },
  {
    type: "item.completed",
    item: {
      id: "f1",
      type: "file_change",
      changes: [
        { path: "src/footer.tsx", kind: "add" },
        { path: "README.md", kind: "update" },
      ],
      status: "completed",
    },
  },
  { type: "item.completed", item: { id: "r1", type: "reasoning", text: "thinking" } },
  { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Added the footer." } },
  { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } },
].map((line) => JSON.stringify(line));

it("maps a codex exec turn onto the events the app-server's items become", () => {
  const parser = new CodexExecParser("run");
  const events = lines.flatMap((line, index) => parser.parseLine(line, 1000 + index));
  expect(events.map((event) => event.type)).toEqual([
    "session.started",
    "turn.started",
    "tool.started",
    "tool.completed",
    "tool.completed",
    "file.changed",
    "file.changed",
    "message.completed",
    "turn.completed",
  ]);
  expect(events[0]).toMatchObject({ agent: "codex", externalSessionId: "019a-thread" });
  expect(events[3]).toMatchObject({ name: "shell", input: { command: "npm test" }, output: "ok\n", isError: false });
  expect(events.filter((event) => event.type === "file.changed")).toMatchObject([
    { path: "src/footer.tsx", kind: "add" },
    { path: "README.md", kind: "modify" },
  ]);
  expect(events.at(-1)).toMatchObject({ type: "turn.completed", status: "success", resultText: "Added the footer.", durationMs: 6 });
  expect(parser.turns).toBe(1);
});

it("reports a failed command and a failed turn, and leaves out lines it does not know", () => {
  const parser = new CodexExecParser("run");
  parser.parseLine(JSON.stringify({ type: "turn.started" }), 0);
  expect(parser.parseLine(JSON.stringify({ type: "item.completed", item: { id: "c", type: "command_execution", command: "false", exit_code: 1 } }))[0]).toMatchObject({
    isError: true,
    status: "error",
  });
  expect(parser.parseLine(JSON.stringify({ type: "turn.failed", error: { message: "usage limit reached" } }), 10)).toMatchObject([
    { type: "error", message: "usage limit reached" },
    { type: "turn.completed", status: "error" },
  ]);
  expect(parser.parseLine("not json")).toEqual([]);
  expect(parser.parseLine(JSON.stringify({ type: "something.new" }))).toEqual([]);
});
