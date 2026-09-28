import { Db, teamDeletedThreads, threads } from "@openorc/db";
import { OrchestrationService } from "../services/orchestration.js";
import { TeamConversationService } from "../services/team-conversation.js";
import { TeamTaskService } from "../services/team-tasks.js";
import { teamTurnChanges } from "../services/team-turn-changes.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  orchestrationService: Pick<OrchestrationService, "list" | "get" | "save" | "archive" | "memberAvatars" | "setMemberAvatar" | "resetMemberAvatar" | "preflight">;
  teamConversations: Pick<
    TeamConversationService,
    | "availability"
    | "runtime"
    | "taskRuntime"
    | "stop"
    | "retry"
    | "compact"
    | "cancelDirection"
    | "sendNow"
    | "send"
    | "implementPlan"
    | "configureLead"
    | "retrySetup"
    | "acceptSetup"
    | "retryIntegration"
    | "acceptIntegration"
  >;
  teamTasks: Pick<TeamTaskService, "state" | "start" | "retry" | "sendReview">;
  db: Db;
};

export function createOrchestrationHandlers({
  orchestrationService,
  teamConversations,
  teamTasks,
  db,
}: Dependencies): Pick<
  Handlers,
  | "orchestration.list"
  | "orchestration.get"
  | "orchestration.save"
  | "orchestration.archive"
  | "orchestration.avatars.list"
  | "orchestration.avatars.set"
  | "orchestration.avatars.reset"
  | "orchestration.preflight"
  | "orchestration.availability"
  | "orchestration.taskState"
  | "orchestration.tasks.start"
  | "orchestration.tasks.retry"
  | "orchestration.review.send"
  | "orchestration.turnChanges"
  | "orchestration.runtime"
  | "orchestration.taskRuntime"
  | "orchestration.stop"
  | "orchestration.retry"
  | "orchestration.compact"
  | "orchestration.cancelDirection"
  | "orchestration.sendNow"
  | "orchestration.send"
  | "orchestration.implementPlan"
  | "orchestration.configureLead"
  | "orchestration.workspace.retrySetup"
  | "orchestration.workspace.acceptSetup"
  | "orchestration.integration.retry"
  | "orchestration.integration.accept"
> {
  return {
    "orchestration.list": ({ projectId, includeArchived }) => orchestrationService.list(projectId, includeArchived),
    "orchestration.get": ({ id }) => orchestrationService.get(id),
    "orchestration.save": (input) => orchestrationService.save(input),
    "orchestration.archive": (input) => orchestrationService.archive(input),
    "orchestration.avatars.list": ({ teamId }) => orchestrationService.memberAvatars(teamId),
    "orchestration.avatars.set": (input) => orchestrationService.setMemberAvatar(input),
    "orchestration.avatars.reset": (input) => orchestrationService.resetMemberAvatar(input),
    "orchestration.preflight": (input) => orchestrationService.preflight(input),
    "orchestration.availability": () => teamConversations.availability(),
    "orchestration.taskState": ({ taskId }) => teamTasks.state(taskId),
    "orchestration.tasks.start": (input) => teamTasks.start(input),
    "orchestration.tasks.retry": (input) => teamTasks.retry(input),
    "orchestration.review.send": (input) => teamTasks.sendReview(input),
    "orchestration.turnChanges": (input) => teamTurnChanges(db, input),
    "orchestration.runtime": ({ threadId }) => (threads.get(db, threadId) && !teamDeletedThreads.has(db, threadId) ? teamConversations.runtime(threadId) : null),
    "orchestration.taskRuntime": ({ taskId }) => teamConversations.taskRuntime(taskId),
    "orchestration.stop": (input) => teamConversations.stop(input),
    "orchestration.retry": (input) => teamConversations.retry(input),
    "orchestration.compact": (input) => teamConversations.compact(input),
    "orchestration.cancelDirection": (input) => teamConversations.cancelDirection(input),
    "orchestration.sendNow": (input) => teamConversations.sendNow(input),
    "orchestration.send": (input) => teamConversations.send(input),
    "orchestration.implementPlan": (input) => teamConversations.implementPlan(input),
    "orchestration.configureLead": (input) => teamConversations.configureLead(input),
    "orchestration.workspace.retrySetup": (input) => teamConversations.retrySetup(input),
    "orchestration.workspace.acceptSetup": (input) => teamConversations.acceptSetup(input),
    "orchestration.integration.retry": (input) => teamConversations.retryIntegration(input),
    "orchestration.integration.accept": (input) => teamConversations.acceptIntegration(input),
  };
}
