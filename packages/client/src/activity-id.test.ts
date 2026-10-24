import { describe, expect, it } from "vitest";
import { activityBlockId, activityIdOf } from "./transcript.js";

describe("activity block ids", () => {
  it("round-trips the agent's activity id through the transcript's block id", () => {
    expect(activityBlockId("exec-1")).toBe("activity-exec-1");
    expect(activityIdOf(activityBlockId("exec-1"))).toBe("exec-1");
    expect(activityIdOf(activityBlockId("activity-nested"))).toBe("activity-nested");
  });
});
