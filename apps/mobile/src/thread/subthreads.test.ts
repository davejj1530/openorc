import type { ThreadSummary } from "@openorc/protocol";
import { describe, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ useRpc: () => ({ data: undefined, isLoading: false }) }));
const { subthreadsOf } = await import("./subthreads");

const row = (id: string, parentThreadId: string | null, createdAt: number, parentRelation: ThreadSummary["parentRelation"] = null) =>
  ({ id, parentThreadId, parentRelation, createdAt }) as ThreadSummary;

describe("subthreadsOf", () => {
  it("lists the threads directly under one, newest first, leaving out its agent's subagents and deeper threads", () => {
    const rows = [row("root", null, 1), row("old", "root", 2), row("agent", "root", 3, "subagent"), row("new", "root", 4, "started"), row("grandchild", "new", 5), row("other", null, 6)];
    expect(subthreadsOf(rows, "root").map((thread) => thread.id)).toEqual(["new", "old"]);
    expect(subthreadsOf(undefined, "root")).toEqual([]);
  });
});
