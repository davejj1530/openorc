import { Db, memories } from "@openorc/db";
import { type McpHost } from "@openorc/mcp";
import { MemoryService } from "../services/memory.js";
import { RunService } from "../services/runs.js";
import type { RunContext } from "./context.js";
type Dependencies = {
  memoryService: Pick<MemoryService, "enabled" | "assertEnabled" | "retrieve" | "taskContext" | "record" | "feedback">;
  runService: Pick<RunService, "authorizeAppAction">;
  db: Db;
  assertTeamActor: RunContext["assertTeamActor"];
  taskFor: RunContext["taskFor"];
  projectFor: RunContext["projectFor"];
};
export function createMemoryHost({
  memoryService,
  runService,
  db,
  assertTeamActor,
  taskFor,
  projectFor,
}: Dependencies): Pick<McpHost, "memoryEnabled" | "memorySearch" | "taskContext" | "memoryRecord" | "memoryFeedback"> {
  return {
    memoryEnabled: () => memoryService.enabled(),
    memorySearch: async (runId, query, limit) => {
      memoryService.assertEnabled();
      const projectId = projectFor(runId);
      if (!projectId) throw new Error("A project-scoped run is required.");
      const hits = await memoryService.retrieve(projectId, query, limit);
      return hits.map(({ memory }) => ({
        id: memory.id,
        type: memory.type,
        title: memory.title,
        summary: memory.body.length > 200 ? memory.body.slice(0, 200) + "…" : memory.body,
        ageDays: Math.round((Date.now() - memory.lastConfirmedAt) / 86_400_000),
        confidence: memory.confidence,
      }));
    },
    taskContext: async (runId) => {
      assertTeamActor(runId);
      const task = taskFor(runId);
      return task ? memoryService.taskContext(task) : "No task context.";
    },
    memoryRecord: async (runId, entry) => {
      const projectId = projectFor(runId);
      if (!projectId) throw new Error("A project-scoped run is required.");
      await runService.authorizeAppAction(runId, "memory_write", { toolName: "memory_record", reason: `Save to project memory: ${entry.title}`, input: entry });
      const task = taskFor(runId);
      const memory = memoryService.record({
        projectId,
        type: entry.type as never,
        title: entry.title,
        body: entry.body,
        topicKey: entry.topicKey ?? null,
        source: "agent",
        sourceRunId: runId,
        sourceTaskId: task?.id ?? null,
      });
      return { id: memory.id };
    },
    memoryFeedback: async (runId, id, verdict) => {
      memoryService.assertEnabled();
      const projectId = projectFor(runId);
      const memory = memories.get(db, id);
      if (!projectId || !memory || (memory.projectId !== null && memory.projectId !== projectId)) throw new Error("Memory not found in this project.");
      if (memory.source === "user" && verdict !== "helpful") throw new Error("Only the user can retract a memory they wrote.");
      await runService.authorizeAppAction(runId, "memory_write", { toolName: "memory_feedback", reason: `Mark the memory "${memory.title}" as ${verdict}`, input: { id, verdict } });
      memoryService.feedback(id, verdict);
    },
  };
}
