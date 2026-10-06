import { Db, orchestration, teamDeletedThreads, threads } from "@openorc/db";
import { type McpHost } from "@openorc/mcp";
import { createHash } from "node:crypto";
import { TeamConversationService } from "../services/team-conversation.js";
import { ThreadService } from "../services/threads.js";
import { reachesThread } from "../services/thread-agent-tools.js";
import type { RunContext } from "./context.js";
type Dependencies = {
  threadService: Pick<ThreadService, "toolThreadList" | "toolThreadRead" | "sourceThreadFor" | "toolThreadSend" | "toolThreadStart">;
  teamConversations: Pick<TeamConversationService, "senderAttribution" | "relay">;
  db: Db;
  assertTeamActor: RunContext["assertTeamActor"];
};
export function createThreadsHost({ threadService, teamConversations, db, assertTeamActor }: Dependencies): Pick<McpHost, "threads"> {
  return {
    threads: {
      list: (runId) => {
        assertTeamActor(runId);
        return threadService.toolThreadList(runId);
      },
      read: (runId, id, limit) => {
        assertTeamActor(runId);
        return threadService.toolThreadRead(runId, id, limit);
      },
      start: (runId, input) => {
        assertTeamActor(runId);
        return threadService.toolThreadStart(runId, input);
      },
      send: async (runId, id, text, requestKey) => {
        assertTeamActor(runId);
        const attribution = teamConversations.senderAttribution(runId);
        const source = threadService.sourceThreadFor(runId);
        const target = threads.get(db, id);
        if (!source) return { delivered: false, message: "Only a thread can message other threads." };
        if (!target || !reachesThread(db, runId, source, target) || teamDeletedThreads.has(db, id)) return { delivered: false, message: "No such thread in this project." };
        if (target.id === source.id) return { delivered: false, message: "That is this thread." };
        if (!orchestration.getInstance(db, id)) return threadService.toolThreadSend(runId, id, text, attribution ?? undefined, requestKey);
        // A retried tool call without a key must not deliver twice; identical intentional repeats need distinct keys.
        const key = requestKey ?? `${runId}:${createHash("sha256").update(text).digest("hex")}`;
        return threadService.toolThreadSend(runId, id, text, attribution ?? undefined, requestKey, (source, target) => {
          assertTeamActor(runId);
          teamConversations.relay({
            threadId: id,
            text,
            requestKey: key,
            source: { threadId: source.id, title: source.title, member: attribution?.member ?? null, team: attribution?.team ?? null },
          });
          return `Queued for the lead of "${target.title}". The lead reads it on its next turn.`;
        });
      },
    },
  };
}
