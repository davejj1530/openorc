import type { HostedFileScope, OnlineTaskRef, SpacesStatus } from "@openorc/protocol";
import type { TaskToolSource } from "@openorc/client";

export type TaskCardSource = { kind: "local" } | { kind: "unavailable" } | { kind: "online"; reference: OnlineTaskRef };
export function taskCardSource(id: string, tool: TaskToolSource, hosted: boolean, scope: HostedFileScope | null, status: SpacesStatus | undefined): TaskCardSource {
  if (!hosted && tool.kind === "none") return { kind: "local" };
  if (tool.kind === "unavailable" || status?.state !== "ready") return { kind: "unavailable" };
  const target = tool.kind === "online" ? tool.reference : implicitTaskScope(scope);
  if (!target || !status.spaces.some((space) => space.id === target.spaceId)) return { kind: "unavailable" };
  if (hosted && !sameScope(scope, status.userId, target)) return { kind: "unavailable" };
  return { kind: "online", reference: { kind: "online", accountId: status.userId, spaceId: target.spaceId, projectId: target.projectId, id } };
}
function implicitTaskScope(scope: HostedFileScope | null) {
  return scope?.destination.kind === "hosted" ? { spaceId: scope.spaceId, projectId: scope.destination.projectId } : null;
}
function sameScope(scope: HostedFileScope | null, accountId: string, target: { spaceId: string; projectId: string }): boolean {
  return scope?.accountId === accountId && scope.spaceId === target.spaceId && scope.destination.kind === "hosted" && scope.destination.projectId === target.projectId;
}
