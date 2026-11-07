import type { Project, Task } from "@openorc/protocol";

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
