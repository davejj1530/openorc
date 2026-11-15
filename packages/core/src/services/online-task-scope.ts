import type { Hosted } from "@openorc/hosted";
import type { TaskScope } from "@openorc/mcp";
import type { OnlineTask } from "@openorc/protocol";

const CHANGED = "This run's OpenOrc session or project access changed.";

export interface OnlineTaskScopeDependencies {
  account(): Pick<Hosted, "tasks" | "spaces"> | null;
  projectFor(runId: string): string | null;
  captureProcess(runId: string): () => boolean;
}

/**
 * An online task call's target, captured for one call of one local run: the signed-in account, the run's process and
 * its local project, which must be the server project the agent named in this space. `assert` holds them as captured.
 */
export async function captureOnlineTaskScope(deps: OnlineTaskScopeDependencies, runId: string, target: TaskScope) {
  const account = deps.account();
  const localProject = deps.projectFor(runId);
  const active = deps.captureProcess(runId);
  if (!account || !localProject || !active()) throw new Error("This run is no longer available.");
  const available = account.tasks.state(target);
  if (available.state !== "ready" || !available.execution) throw new Error("Online task tools aren't available here.");
  const identity = account.tasks.capture(target.spaceId);
  // The run's account, session, process and project as captured: any change after a wait ends the call before it writes.
  const assert = () => {
    try {
      identity.assert();
    } catch {
      throw new Error(CHANGED);
    }
    if (deps.account() !== account || !active() || deps.projectFor(runId) !== localProject) throw new Error(CHANGED);
  };
  const projects = await account.spaces.projects(target.spaceId);
  assert();
  if (!projects.some((project) => project.localProjectId === localProject && project.hostedProjectId === target.projectId)) throw new Error("This project isn't available to this run.");
  return {
    ...target,
    key: JSON.stringify([runId, identity.accountId, target.spaceId, target.projectId]),
    tasks: account.tasks,
    assert,
    task(task: OnlineTask) {
      assert();
      if (task.spaceId !== target.spaceId || task.projectId !== target.projectId) throw new Error("This task isn't in this run's project.");
      return task;
    },
  };
}
export type CapturedOnlineTaskScope = Awaited<ReturnType<typeof captureOnlineTaskScope>>;
