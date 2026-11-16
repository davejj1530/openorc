import { useState } from "react";
import type { SpaceProject } from "@openorc/protocol";
import { ProjectEnvironmentDialog } from "../dialogs/ProjectEnvironmentDialog";
import { useRpc } from "./client";
import { useSpaceNavigation } from "./space-navigation";

type Target = { spaceId: string; project: SpaceProject & { hostedProjectId: string } };

/** A cloud project's own environment, offered where the space's server keeps one. The menu captures both IDs, as Project access does. */
export function useProjectEnvironment(projectId: string) {
  const current = useSpaceNavigation((state) => state.current);
  const available = useRpc("hostedEnvironment.available", { spaceId: current ?? "" }, { enabled: current !== null, staleTime: 60_000 });
  const projects = useRpc("spaces.projects", { spaceId: current ?? "" }, { enabled: available.data === true });
  const project = projects.data?.find((project) => project.key === projectId);
  const [target, setTarget] = useState<Target | null>(null);
  const hostedProjectId = project?.hostedProjectId;
  const open = current && project && hostedProjectId ? () => setTarget({ spaceId: current, project: { ...project, hostedProjectId } }) : null;
  return {
    open,
    dialog: target ? <ProjectEnvironmentDialog {...target} onClose={() => setTarget(null)} /> : null,
  };
}
