import { expect, it } from "vitest";
import { OpenCodeRunParser } from "./run-json.js";

/** Lines as OpenCode 2.0.11's `run --format json` printed them for a turn that ran one command, answered by a stand-in model. */
const SESSION = "ses_e57bdf3a4ffeX5D5WTtPWzfUg1";
const lines = [
  { type: "step_start", sessionID: SESSION, part: { id: "prt_1", messageID: "msg_1", type: "step-start" } },
  {
    type: "tool_use",
    sessionID: SESSION,
    part: { partID: "prt_2", messageID: "msg_1", type: "tool", id: "call_1", tool: "shell", state: { status: "completed", input: { command: "echo hi > made.txt" }, output: "(no output)" } },
  },
  { type: "step_finish", sessionID: SESSION, part: { id: "prt_3", type: "step-finish", reason: "tool-calls", tokens: { input: 0, output: 0 } } },
  { type: "step_start", sessionID: SESSION, part: { id: "prt_4", messageID: "msg_2", type: "step-start" } },
  { type: "text", sessionID: SESSION, part: { id: "prt_5", messageID: "msg_2", type: "text", text: "Made the file." } },
].map((line) => JSON.stringify(line));

it("reads the session, each command and the reply, and closes the turn when the process ends, since the stream does not", () => {
  const parser = new OpenCodeRunParser("run-1");
  const events = lines.flatMap((line) => parser.parseLine(line, 10));
  expect(events.map((event) => event.type)).toEqual(["session.started", "turn.started", "tool.started", "tool.completed", "message.completed"]);
  expect(events[0]).toMatchObject({ agent: "opencode", externalSessionId: SESSION });
  expect(events[3]).toMatchObject({ toolCallId: "call_1", name: "shell", input: { command: "echo hi > made.txt" }, isError: false, status: "success" });
  expect(parser.end(0, 25)).toEqual([{ type: "turn.completed", runId: "run-1", ts: 25, turnId: "turn-1", status: "success", resultText: "Made the file.", durationMs: 15 }]);
  expect(parser.turns).toBe(1);
});

it("reports the model's failure and ends the turn in error, and takes no session id that is not a plain name", () => {
  const parser = new OpenCodeRunParser("run-1");
  const failed = parser.parseLine(JSON.stringify({ type: "error", sessionID: "ses_../x", error: { type: "provider.internal", message: "stand-in refuses", status: 500 } }), 1);
  expect(failed).toEqual([
    { type: "session.started", runId: "run-1", ts: 1, agent: "opencode", externalSessionId: null, model: null },
    { type: "turn.started", runId: "run-1", ts: 1, turnId: "turn-1" },
    { type: "error", runId: "run-1", ts: 1, message: "stand-in refuses", fatal: false },
  ]);
  expect(parser.end(1, 2)).toMatchObject([{ type: "turn.completed", status: "error" }]);
  expect(new OpenCodeRunParser("run-2").end(1)).toEqual([]);
});
