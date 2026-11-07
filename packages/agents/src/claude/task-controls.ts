import type { RunControls } from "../run-handle.js";
import type { ClaudeStreamParser } from "./stream-json.js";
import type { AgentEvent } from "@openorc/protocol";

/** stop_task is a control, so stopping owned work never supplies another user turn. */
export function claudeTaskControls(
  parser: ClaudeStreamParser,
  available: () => boolean,
  stop: (taskId: string) => Promise<void>,
  emit: (event: AgentEvent) => void,
): Pick<RunControls, "stopCommand" | "canStopSubagent" | "stopSubagent"> {
  return {
    stopCommand: async (id) => {
      if (available() && parser.backgroundCommands.some((command) => command.id === id)) await stop(id);
    },
    canStopSubagent: (id) => available() && parser.subagentTaskId(id) !== null,
    stopSubagent: async (id) => {
      const taskId = parser.subagentTaskId(id);
      if (taskId && available()) {
        await stop(taskId);
        for (const event of parser.stoppedSubagents(id)) emit(event);
      }
    },
  };
}
