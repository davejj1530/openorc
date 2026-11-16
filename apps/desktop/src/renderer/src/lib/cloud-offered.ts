import { hostedStart, targetModel, type NewThreadTarget, type StartBlock } from "@openorc/client";
import { WORKSPACE_ID, type AccountStatus, type SpaceProject, type CloudHours } from "@openorc/protocol";
import { useRpc } from "./client";
import { useSpaceNavigation } from "./space-navigation";

/** OpenOrc Cloud in a new thread's place menu: offered to a person with an account, for a project's model, blocked with why it can't start there now. */
export interface NewThreadHosted {
  shown: boolean;
  blocked: StartBlock | null;
  can: boolean;
  /** The cloud hours left, for the row's end. */
  hours: CloudHours | null;
}

export function useNewThreadHosted(target: NewThreadTarget, projectId: string): NewThreadHosted {
  const detached = useDetachedProject(projectId);
  const account = useRpc("account.status", {}).data;
  const current = useSpaceNavigation((state) => state.current);
  const personal = useSpaceNavigation((state) => state.current === state.personal);
  const project = useSpaceNavigation((state) => state.inventory.find((space) => space.id === state.current)?.projects.find((project) => project.key === projectId));
  const choice = target.kind === "model" ? targetModel(target) : null;
  const scoped = scopedHostedAccount(account, current, projectId, project);
  const { shown, blocked } = hostedStart(scoped, { projectId, agent: choice?.agent ?? "", model: choice?.model ?? null });
  const offered = shown && target.kind === "model" && projectId !== WORKSPACE_ID && !detached;
  const scopeBlock: StartBlock | null = current && !personal && !project?.hostedProjectId ? { words: "This project isn't available in this space.", fix: null, reason: "No access" } : null;
  const denied = scopeBlock ?? blocked;
  return { shown: offered, blocked: denied, can: offered && choice !== null && !denied, hours: account?.state === "signed-in" ? account.hours : null };
}

function useDetachedProject(projectId: string): boolean {
  return useSpaceNavigation((state) => Boolean(state.inventory.find((space) => space.id === state.current)?.detached?.projects.some((project) => project.key === projectId)));
}

function scopedHostedAccount(account: AccountStatus | undefined, current: string | null, projectId: string, project: SpaceProject | undefined): AccountStatus | undefined {
  // A project from a folder of this Mac has no repository: it is added once its Personal project is paired with it.
  if (!current || account?.state !== "signed-in" || !project?.hostedProjectId) return account;
  return { ...account, projects: [{ projectId, repo: project.repo ?? project.name, cloud: "added" }] };
}
