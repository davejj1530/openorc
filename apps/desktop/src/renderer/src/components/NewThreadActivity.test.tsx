import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ThreadSummary } from "@openorc/protocol";
import { threadListParams } from "@openorc/client";
import { WORKSPACE_ID } from "@openorc/protocol";
import { useArrivalActivity } from "./NewThreadActivity";

const reads = vi.hoisted(() => ({ params: [] as unknown[] }));
vi.mock("../lib/client", () => ({
  useRpc: () => ({ data: [] }),
  useRpcs: (_method: string, params: unknown[]) => {
    reads.params = params;
    return [
      {
        data: [
          ...Array.from({ length: 80 }, (_, i) => ({ id: `child-${i}`, parentRelation: "subagent", activity: "running", lastActivityAt: 2 })),
          { id: "parent", parentRelation: null, activity: "idle", lastActivityAt: 1 },
          { id: "started", parentRelation: "started", activity: "idle", lastActivityAt: 1 },
        ] as ThreadSummary[],
      },
    ];
  },
}));
afterEach(cleanup);
it("keeps parent and started conversations in recent activity when many subagents are active", () => {
  const { result } = renderHook(useArrivalActivity);
  expect(result.current.recent.map((thread) => thread.id).sort()).toEqual(["parent", "started"]);
  expect(result.current.running).toEqual([]);
  expect(reads.params).toEqual([threadListParams(WORKSPACE_ID, "active")]);
});
