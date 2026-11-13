import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { antigravityOwnTurns, antigravityTranscript } from "./own-turns.js";

/** Steps as Antigravity writes them for a command it ran as a background task, and the turn the task's end started. */
const steps = [
  { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nBuild it in the background\n</USER_REQUEST>" },
  {
    step_index: 1,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    thinking: "Start it",
    tool_calls: [{ name: "run_command", args: { CommandLine: "pnpm build", WaitMsBeforeAsync: 500 } }],
  },
  {
    step_index: 2,
    source: "MODEL",
    type: "GENERIC",
    status: "RUNNING",
    content: "Tool is running as a background task with task id: ses-1/task-2\nTask Description: pnpm build\nTask logs are available at: file:///tmp/example/task-2.log",
  },
  { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "Started the build." },
  {
    step_index: 4,
    source: "SYSTEM",
    type: "SYSTEM_MESSAGE",
    status: "DONE",
    content:
      '<SYSTEM_MESSAGE>\n[Message] sender=ses-1/task-2 content=Task id "ses-1/task-2" finished with result:\nCommand exited with code 0.\n\nCommand output:\nbuilt\r\n\nLog: file:///tmp/example/task-2.log\n</SYSTEM_MESSAGE>',
  },
  { step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "Checking.", tool_calls: [{ name: "view_file", args: { AbsolutePath: "/tmp/example/a" } }] },
  { step_index: 6, source: "MODEL", type: "GENERIC", status: "ERROR", error: "file does not exist", content: "Encountered error" },
  { step_index: 7, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "The build passed." },
];

describe("antigravityOwnTurns", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "openorc-agy-"));
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  it("reads a conversation's steps as entries, a turn ending at each reply that calls no tool", async () => {
    const file = antigravityTranscript({ HOME: home }, "ses-1");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${steps.map((step) => JSON.stringify(step)).join("\n")}\n{"step_index": 8, "type": "PLANNER`);
    const entries = await antigravityOwnTurns.read(async () => "", "ses-1", null, { HOME: home });
    expect(entries.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
      "user:step-0",
      "assistant:step-1",
      "other:step-2",
      "assistant:step-3",
      "idle:step-3:end",
      "other:step-4",
      "assistant:step-5",
      "assistant:step-6",
      "assistant:step-7",
      "idle:step-7:end",
    ]);
    expect(entries[0]).toMatchObject({ text: "Build it in the background" });
    expect(entries[5]).toEqual({ id: "step-4", kind: "other", job: { id: "ses-1/task-2", state: "completed", exit: 0, output: "built", command: "pnpm build" } });
    expect(entries[6]).toMatchObject({ updates: [{ sessionUpdate: "agent_message_chunk" }, { sessionUpdate: "tool_call", toolCallId: "step-5:tool-0", name: "view_file" }] });
    expect(entries[7]).toMatchObject({ updates: [{ sessionUpdate: "tool_call_update", toolCallId: "step-5:tool-0", status: "failed", rawOutput: { error: "file does not exist" } }] });
  });

  it("reads nothing for a conversation not written yet, and refuses an id that would leave its folder", async () => {
    await expect(antigravityOwnTurns.read(async () => "", "ses-2", null, { HOME: home })).resolves.toEqual([]);
    await expect(antigravityOwnTurns.read(async () => "", "../ses", null, { HOME: home })).rejects.toThrow();
  });

  it("takes a command call still open when its turn ended for the background task it started", () => {
    expect(antigravityOwnTurns.leftRunning!({ id: "call_1", name: "run_command", input: { CommandLine: "pnpm build\n--watch" } })).toEqual({ id: "call_1", description: "pnpm build" });
    expect(antigravityOwnTurns.leftRunning!({ id: "call_2", name: "view_file", input: {} })).toBeNull();
  });
});
