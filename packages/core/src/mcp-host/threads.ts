import { Db, retiredTeams, threads } from "@openorc/db";
import { type McpHost } from "@openorc/mcp";
import { reachesThread } from "../services/thread-agent-tools.js";
import { ThreadService } from "../services/threads.js";
import type { RunContext } from "./context.js";
type Dependencies = {
  threadService: Pick<ThreadService, "toolThreadList" | "toolThreadRead" | "sourceThreadFor" | "toolThreadSend" | "toolThreadStart">;
  db: Db;
  assertRunAvailable: RunContext["assertRunAvailable"];
};
export function createThreadsHost({ threadService, db, assertRunAvailable }: Dependencies): Pick<McpHost, "threads"> {
  return {
    threads: {
      list: (runId) => {
        assertRunAvailable(runId);
        return threadService.toolThreadList(runId);
      },
      read: (runId, id, limit) => {
        assertRunAvailable(runId);
        return threadService.toolThreadRead(runId, id, limit);
      },
      start: (runId, input) => {
        assertRunAvailable(runId);
        return threadService.toolThreadStart(runId, input);
      },
      send: async (runId, id, text, requestKey) => {
        assertRunAvailable(runId);
        const source = threadService.sourceThreadFor(runId);
        const target = threads.get(db, id);
        if (!source) return { delivered: false, message: "Only a thread can message other threads." };
        if (!target || !reachesThread(db, runId, source, target) || retiredTeams.isHidden(db, id)) return { delivered: false, message: "No such thread in this project." };
        if (target.id === source.id) return { delivered: false, message: "That is this thread." };
        return threadService.toolThreadSend(runId, id, text, requestKey);
      },
    },
  };
}
