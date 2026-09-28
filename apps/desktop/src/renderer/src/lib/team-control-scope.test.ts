import { describe, expect, it } from "vitest";
import type { TeamConversation, TeamRetainedTaskRuntime } from "@openorc/protocol";
import { teamControlParams, teamRuntimeData, teamRuntimeQueryKey, teamTaskScope } from "./team-control-scope";

describe("team control scope", () => {
  it("adds the surviving task only when a retained owner is being controlled", () => {
    expect(teamControlParams("thread")).toEqual({ threadId: "thread" });
    expect(teamControlParams("thread", "task")).toEqual({ threadId: "thread", taskId: "task" });
    expect(teamTaskScope()).toEqual({});
    expect(teamTaskScope("task")).toEqual({ taskId: "task" });
  });

  it("reads a retained owner through the task runtime query", () => {
    expect(teamRuntimeQueryKey("thread")).toEqual(["orchestration.runtime", { threadId: "thread" }]);
    expect(teamRuntimeQueryKey("thread", "task")).toEqual(["orchestration.taskRuntime", { taskId: "task" }]);
  });

  it("unwraps whichever runtime shape is cached", () => {
    const runtime = { policy: { runs: [] } } as unknown as TeamConversation;
    const retained = { thread: {}, runtime, deletedAt: 1 } as unknown as TeamRetainedTaskRuntime;
    expect(teamRuntimeData(runtime)).toBe(runtime);
    expect(teamRuntimeData(retained)).toBe(runtime);
    expect(teamRuntimeData(null)).toBeUndefined();
    expect(teamRuntimeData(undefined)).toBeUndefined();
  });
});
