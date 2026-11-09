import { describe, expect, it, vi } from "vitest";
import { openCodeOwnTurns } from "./own-turns.js";

const page = (data: unknown[], next?: string) => JSON.stringify({ data, cursor: { next } });

describe("openCodeOwnTurns", () => {
  it("reads the session's messages oldest first, as the updates OpenCode's ACP server would stream", async () => {
    const run = vi.fn(async () =>
      page([
        { id: "msg_5", type: "idle", outcome: "succeeded" },
        {
          id: "msg_4",
          type: "assistant",
          content: [
            { type: "reasoning", text: "Check the log" },
            { type: "tool", id: "toolu_1", name: "shell", state: { status: "completed", input: { command: "tail build.log" }, content: [{ type: "text", text: "ok\n" }] } },
            { type: "tool", id: "toolu_2", name: "read", state: { status: "error", input: { path: "/tmp/x" }, error: { message: "No such file" } } },
            { type: "text", text: "The build passed." },
          ],
        },
        { id: "msg_3", type: "synthetic", metadata: { source: "shell", shellID: "sh_1", state: "completed", exit: 0 }, text: "<shell …>" },
        { id: "msg_2", type: "system", text: "Environment changed" },
        { id: "msg_1", type: "user", text: "Build it" },
      ]),
    );
    const entries = await openCodeOwnTurns.read(run, "ses_1", null, {});
    expect(run).toHaveBeenCalledWith(["api", "--standalone", "GET", "/api/session/ses_1/message"]);
    expect(entries).toEqual([
      { id: "msg_1", kind: "user", text: "Build it" },
      { id: "msg_2", kind: "other" },
      { id: "msg_3", kind: "other", job: { id: "sh_1", state: "completed", exit: 0 } },
      {
        id: "msg_4",
        kind: "assistant",
        updates: [
          { sessionUpdate: "agent_thought_chunk", messageId: "msg_4:reasoning:0", content: { type: "text", text: "Check the log" } },
          { sessionUpdate: "tool_call", toolCallId: "toolu_1", name: "shell", title: "shell", rawInput: { command: "tail build.log" }, status: "pending" },
          { sessionUpdate: "tool_call_update", toolCallId: "toolu_1", status: "completed", rawOutput: { output: "ok\n" } },
          { sessionUpdate: "tool_call", toolCallId: "toolu_2", name: "read", title: "read", rawInput: { path: "/tmp/x" }, status: "pending" },
          { sessionUpdate: "tool_call_update", toolCallId: "toolu_2", status: "failed", rawOutput: { error: "No such file" } },
          { sessionUpdate: "agent_message_chunk", messageId: "msg_4", content: { type: "text", text: "The build passed." } },
        ],
      },
      { id: "msg_5", kind: "idle", outcome: "success" },
    ]);
  });

  it("reads older pages until it reaches the message it was asked to reach back to", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(page([{ id: "msg_9", type: "idle", outcome: "succeeded" }], "older"))
      .mockResolvedValueOnce(page([{ id: "msg_2", type: "idle", outcome: "interrupted" }], "oldest"));
    const entries = await openCodeOwnTurns.read(run, "ses_1", "msg_2", {});
    expect(run).toHaveBeenLastCalledWith(["api", "--standalone", "GET", "/api/session/ses_1/message", "--param", "cursor=older"]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(entries.map((entry) => entry.id)).toEqual(["msg_2", "msg_9"]);
    expect(entries[0]).toMatchObject({ outcome: "cancelled" });
  });

  it("refuses a session id that would change the request's path", async () => {
    await expect(openCodeOwnTurns.read(async () => page([]), "../ses", null, {})).rejects.toThrow();
  });

  it("names the shell command OpenCode moved to the background", () => {
    const output = "Command moved to the background (shell ID: sh_1bfb0ea3).\nOutput is streaming to: /tmp/example.out\nYou will be notified automatically when the command finishes.";
    expect(openCodeOwnTurns.startedJob!({ name: "shell", input: { command: "pnpm build\n--verbose" }, output })).toEqual({ id: "sh_1bfb0ea3", description: "pnpm build" });
    expect(openCodeOwnTurns.startedJob!({ name: "shell", input: { command: "ls" }, output: "a\nb" })).toBeNull();
    expect(openCodeOwnTurns.startedJob!({ name: "read", input: {}, output })).toBeNull();
  });
});
