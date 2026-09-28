import type { Project, Task, TeamTaskView } from "@openorc/protocol";

const PUBLICATION_REASONS = {
  integrated: "Publish integrated team changes from the main team conversation. This assignment’s workspace is kept for review.",
  ownershipError: "Task ownership could not be checked. Retry before changing its workspace or sending comments.",
  ownershipPending: "Checking task ownership…",
};

/** A current export report takes precedence over a background ownership refresh. */
export function taskPublicationBlockedReason({
  hasOwner,
  team,
  isError,
  isPending,
}: {
  hasOwner: boolean;
  team: Pick<TeamTaskView, "export"> | null | undefined;
  isError: boolean;
  isPending: boolean;
}): string | null {
  if (!hasOwner) return null;
  if (team?.export) return team.export.allowed ? null : team.export.reason;
  if (team) return PUBLICATION_REASONS.integrated;
  if (isError) return PUBLICATION_REASONS.ownershipError;
  if (isPending) return PUBLICATION_REASONS.ownershipPending;
  return null;
}

/** An assignment's baseRef is a commit; its pull request targets the default branch. */
export function taskBaseLabel(task: Pick<Task, "baseRef">, project: Pick<Project, "defaultBranch">): string | null {
  const isSha = Boolean(task.baseRef && /^[0-9a-f]{40,64}$/.test(task.baseRef));
  return isSha ? project.defaultBranch : (task.baseRef ?? project.defaultBranch);
}

export function taskCompareUrl(project: Pick<Project, "gitRemote" | "defaultBranch">, task: Pick<Task, "branch" | "baseRef">): string | null {
  if (!project.gitRemote || !task.branch) return null;
  const remote = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(project.gitRemote);
  if (!remote) return null;
  const base = taskBaseLabel(task, project) ?? "main";
  return `https://github.com/${remote[1]}/${remote[2]}/compare/${encodeURIComponent(base)}...${encodeURIComponent(task.branch)}?expand=1`;
}
