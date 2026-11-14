import { useMemo } from "react";
import type { HostedFileScope, SpaceProject, SpacesStatus } from "@openorc/protocol";
import { useRpc } from "./client";
import { useSpaceNavigation } from "./space-navigation";

/** Capture the signed-in person and selected space before attaching or reading a cloud file. */
type ScopeInput = { projectId: string; threadId?: string; enabled: boolean };
export function useHostedFileScope(input: ScopeInput): HostedFileScope | null {
  return useHostedFileContext(input).scope;
}

export function useHostedFileContext({ projectId, threadId, enabled }: ScopeInput) {
  const account = useRpc("spaces.status", {}, { enabled });
  const status = account.data;
  const current = useSpaceNavigation((state) => state.current);
  const selectedAccount = useSpaceNavigation((state) => state.inventory.find((space) => space.id === state.current)?.accountId);
  const spaceId = current ?? (status?.state === "ready" ? status.personalSpaceId : null);
  const catalog = useRpc("spaces.projects", { spaceId: spaceId ?? "" }, { enabled: enabled && spaceId !== null });
  const projects = catalog.data;
  const scope = useMemo(() => {
    return enabled ? hostedFileScope({ status, spaceId, projects, selectedAccount, projectId, threadId }) : null;
  }, [status, spaceId, projects, selectedAccount, projectId, threadId, enabled]);
  const identity = status?.state === "ready" && spaceId && (!selectedAccount || selectedAccount === status.userId) ? { apiOrigin: status.apiOrigin, accountId: status.userId, spaceId } : null;
  const unreachable = status?.state === "loading" && status.error ? new Error(status.error) : null;
  return {
    scope,
    identity,
    error: account.error ?? unreachable ?? catalog.error,
    retry: () => {
      void account.refetch();
      void catalog.refetch();
    },
  };
}

export function hostedFileScope(input: {
  status: SpacesStatus | undefined;
  spaceId: string | null;
  projects: SpaceProject[] | undefined;
  selectedAccount?: string | undefined;
  projectId: string;
  threadId?: string | undefined;
}): HostedFileScope | null {
  const { status, spaceId, projects, selectedAccount, projectId, threadId } = input;
  if (status?.state !== "ready" || !spaceId) return null;
  if (!status.spaces.some((space) => space.id === spaceId) || (selectedAccount && selectedAccount !== status.userId)) return null;
  const project = projects?.find((row) => row.key === projectId || row.localProjectId === projectId || row.hostedProjectId === projectId);
  if (!project?.hostedProjectId) return null;
  return { apiOrigin: status.apiOrigin, accountId: status.userId, spaceId, destination: { kind: "hosted", projectId: project.hostedProjectId, ...(threadId && { threadId }) } };
}
