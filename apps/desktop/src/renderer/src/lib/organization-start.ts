import { useOrganization } from "./organization-context";
import { useSpaceNavigation } from "./space-navigation";

/** An organization's own page stands in for New thread until it has a project to start one in. */
export function useOrganizationStart(projectId?: string | null): boolean {
  const organization = useOrganization()?.organization;
  const space = useSpaceNavigation((state) => state.inventory.find((space) => space.id === state.current));
  if (!organization || !space || space.projects.length) return false;
  return !(projectId && space.detached?.projects.some((project) => project.key === projectId));
}
