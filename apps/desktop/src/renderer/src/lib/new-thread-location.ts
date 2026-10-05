import { WORKSPACE_ID, type Project, type WorkspaceMode } from "@openorc/protocol";
import type { ComposerProps } from "../components/Composer";
import { useRpc } from "./query";

/** Local checkout shows HEAD's branch; a future worktree shows the default branch it starts from. */
export function useNewThreadLocation(projectId: string, project: Project | undefined, mode: WorkspaceMode, directory?: string): ComposerProps["location"] {
  const isWorkspace = projectId === WORKSPACE_ID;
  const checkout = useRpc("projects.checkoutBranch", { id: projectId }, { enabled: Boolean(projectId) && !isWorkspace && mode === "current", staleTime: 0 });
  if (isWorkspace) return { label: null, branch: null, directory: directory ?? project?.rootPath ?? "Workspace" };
  if (mode === "worktree") return { label: "New worktree", branch: project?.defaultBranch ?? null };
  return { label: null, branch: checkout.isError ? null : (checkout.data ?? null), directory: project?.rootPath };
}
