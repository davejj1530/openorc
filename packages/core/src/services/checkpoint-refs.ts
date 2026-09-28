/**
 * Where OpenOrc pins the trees it saves, so `git gc` never removes a conversation's checkpoints or a task's
 * snapshots. Each tree is pinned once per owner; deleting the owner deletes its prefix.
 */
export const checkpointRefs = (threadId: string) => `refs/openorc/checkpoints/${threadId}/`;
export const snapshotRefs = (taskId: string) => `refs/openorc/snapshots/${taskId}/`;
