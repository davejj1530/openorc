import type { OnlineTask, OnlineTaskRef } from "@openorc/protocol";

export const onlineReference: OnlineTaskRef = { kind: "online", accountId: "account-a", spaceId: "org:studio", projectId: "project-a", id: "task-a" };
export function onlineTask(patch: Partial<OnlineTask> = {}): OnlineTask {
  return {
    id: onlineReference.id,
    spaceId: onlineReference.spaceId,
    projectId: onlineReference.projectId,
    organizationId: "studio",
    title: "Keep long task titles readable while a teammate changes the document",
    spec: "Saved words",
    status: "backlog",
    priority: "medium",
    labels: [],
    origin: "user",
    creator: { userId: "account-a", name: "Alex", image: null },
    updatedBy: null,
    assignee: null,
    revision: 1,
    assignmentRevision: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    completedAt: null,
    createdIn: { state: "none" },
    execution: { state: "none" },
    activity: null,
    viewer: { unseenAssignment: false, attention: [], mayEdit: true, mayDelete: true, mayOpenThread: false, liveExecution: false },
    ...patch,
  };
}
