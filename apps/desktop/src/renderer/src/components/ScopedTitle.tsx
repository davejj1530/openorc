import type { ReactNode } from "react";
import { focusedProject, useLayout } from "../lib/layout";
import { PageTitle } from "./PageTitle";
import { ProjectScope } from "./ProjectScope";

/**
 * A screen's title led by the app's scope, as in "studio / Tasks" or "All projects / Tasks": the scope opens the choice
 * of project, so the screen says whose it is and can change that. A screen that stands for one project at a time puts
 * its own title in `unscoped` while no project is chosen.
 */
export function ScopedTitle({ children, unscoped }: { children: ReactNode; unscoped?: ReactNode }) {
  const focused = useLayout(focusedProject);
  if (!focused && unscoped) return <PageTitle>{unscoped}</PageTitle>;
  return (
    <span className="title-crumbs">
      <ProjectScope />
      <span aria-hidden="true" className="title-crumb-divider">
        /
      </span>
      <span className="truncate">{children}</span>
    </span>
  );
}
