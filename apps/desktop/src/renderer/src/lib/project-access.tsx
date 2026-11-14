import { useState } from "react";
import type { OrganizationSpace, SpaceProject } from "@openorc/protocol";
import { ProjectAccessDialog } from "../dialogs/ProjectAccessDialog";
import { useRpc } from "./client";
import { useSpaceNavigation } from "./space-navigation";

type Target = { organization: OrganizationSpace; project: SpaceProject & { hostedProjectId: string } };

/** The menu captures both IDs; a later space switch cannot retarget its open dialog. */
export function useProjectAccess(projectId: string) {
  const current = useSpaceNavigation((state) => state.current);
  const status = useRpc("spaces.status", {}, { enabled: current !== null });
  const space = status.data?.state === "ready" ? status.data.spaces.find((space) => space.id === current) : null;
  const organization = space?.kind === "organization" ? space : null;
  const projects = useRpc("spaces.projects", { spaceId: current ?? "" }, { enabled: organization !== null });
  const project = projects.data?.find((project) => project.key === projectId);
  const [target, setTarget] = useState<Target | null>(null);
  const hostedProjectId = project?.hostedProjectId;
  const open = organization?.role === "admin" && project && hostedProjectId ? () => setTarget({ organization, project: { ...project, hostedProjectId } }) : null;
  return {
    organization: organization !== null,
    open,
    dialog: target ? <ProjectAccessDialog {...target} onClose={() => setTarget(null)} /> : null,
  };
}
