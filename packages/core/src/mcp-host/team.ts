import { type McpHost } from "@openorc/mcp";
import { SlackService } from "../services/slack/service.js";
import { TeamCoordinator } from "../services/team-coordinator.js";
type Dependencies = {
  teams: Pick<TeamCoordinator, "binding" | "statusForRun" | "message" | "say" | "claim" | "wait" | "complete" | "contextPart" | "history">;
  slack: Pick<SlackService, "executionAvailable" | "executionContext" | "switchExecution" | "switchToOrcling">;
};
export function createTeamHost({ teams, slack }: Dependencies): Pick<McpHost, "team" | "execution"> {
  return {
    team: {
      available: (runId) => Boolean(teams.binding(runId)),
      status: async (runId) => teams.statusForRun(runId),
      message: async (runId, input) => teams.message(runId, input),
      say: async (runId, input) => teams.say(runId, input),
      claim: async (runId, input) => teams.claim(runId, input),
      wait: async (runId, input) => {
        teams.wait(runId, input);
        return { waiting: true, message: "End your turn. Accepted direction and results will resume this assignment." };
      },
      complete: async (runId, input) => {
        teams.complete(runId, input);
        return { recorded: true, message: "Completion intent recorded. End this turn successfully to capture the result." };
      },
      context: async (runId, input) => teams.contextPart(runId, input.id),
      history: async (runId, input) => teams.history(runId, input),
    },
    execution: {
      available: (runId) => slack.executionAvailable(runId),
      context: (runId) => slack.executionContext(runId),
      switch: (runId, input) => (input.orclingId ? slack.switchToOrcling(runId, input.orclingId, input.instructions) : slack.switchExecution(runId, input)),
    },
  };
}
