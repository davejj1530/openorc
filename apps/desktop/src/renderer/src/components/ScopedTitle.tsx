import type { ReactNode } from "react";
import { focusedProject, useLayout } from "../lib/layout";
import { ProjectFilter } from "./SidebarWorkspaces";

/**
 * A screen's title. With the sidebar hidden and a project focused, the project leads it, as in "studio / Tasks", and
 * opens the sidebar's project filter, so the screen still says whose it is and can change that. `open` stands in while
 * the sidebar shows.
 */
export function ScopedTitle({ children, open = children }: { children: ReactNode; open?: ReactNode }) {
  const hidden = useLayout((state) => !state.sidebarOpen);
  const focused = useLayout(focusedProject);
  if (!hidden || !focused) return open;
  return (
    <span className="scope-crumb">
      <ProjectFilter crumb onSelect={(workspace) => useLayout.getState().setWorkspace(workspace)} />
      <span aria-hidden="true" className="scope-crumb-divider">
        /
      </span>
      <span className="truncate">{children}</span>
    </span>
  );
}
