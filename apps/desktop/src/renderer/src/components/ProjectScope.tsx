import { useState, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { NEEDS_YOU_PAGE, useSidebarNow } from "@openorc/client";
import type { Project } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { useSpaceRpc as useRpc } from "../lib/space-queries";
import { ALL_WORKSPACES, useLayout } from "../lib/layout";
import { useOrclingChatIds } from "../lib/orclings";
import { openProject } from "../lib/router";
import { useUi } from "../lib/ui";
import { floatingGround } from "../lib/use-anchor-ground";
import { useScrollEdges } from "../lib/use-scroll-edges";
import { cn } from "../lib/cn";
import { markThread, projectMarks, projectMarkSummary, type ProjectMark } from "../lib/project-marks";
import { Check, FolderPlus, Folders, Plus, Settings, X } from "./icons";
import { menuItem, menuItemDanger, menuPopup, menuSeparator } from "./menu";
import { ProjectLogo } from "./ProjectIconPicker";
import { RemoveProjectDialog } from "./ProjectMenu";
import { useSidebarProjects } from "./SidebarThreadBrowser";
import { ThreadStatusIndicator } from "./ThreadStatusIndicator";

/**
 * Each project's mark, from the read of threads that need you across every project: the same read the list makes
 * while it shows every project, so it costs nothing more there.
 */
export function useProjectMarks(projectIds: readonly string[], enabled: boolean): Map<string, ProjectMark> {
  const homes = useOrclingChatIds();
  const now = useSidebarNow();
  const needsYou = useRpc(
    "threads.list",
    { projectIds: [...projectIds], filter: "active", orderBy: "activity", includeChildren: true, needsYou: true, limit: NEEDS_YOU_PAGE },
    { enabled, refetchInterval: 60_000 },
  );
  return projectMarks(needsYou.data, now, homes);
}

const ALL_PROJECTS = "All projects";

/** The chosen row, scrolled to the middle of the projects as the menu opens when they run past it. */
const inView = (row: HTMLElement | null) => row?.scrollIntoView?.({ block: "center" });

/** One choice of whose threads to list: chosen or not, the project's icon and name, then its most pressing thread's mark. */
function ScopeItem({ icon, name, chosen, mark, onSelect }: { icon: ReactNode; name: string; chosen: boolean; mark?: ProjectMark | undefined; onSelect: () => void }) {
  const summary = projectMarkSummary(mark);
  return (
    <Menu.Item ref={chosen ? inView : undefined} className={menuItem} aria-description={summary || undefined} onClick={onSelect}>
      <Check size={13} className={chosen ? "text-accent-ink" : "text-transparent"} />
      <span className="sidebar-scope-icon">{icon}</span>
      <span className="sidebar-scope-name">{name}</span>
      {mark ? (
        <span className="sidebar-scope-mark" data-tip={summary}>
          <ThreadStatusIndicator thread={markThread(mark.kind)} />
        </span>
      ) : null}
    </Menu.Item>
  );
}

/**
 * The project at the head of a screen's title, the app's scope: All projects, or one project. It opens on All projects,
 * then each project with its most pressing thread's mark; the chosen project's settings, a new task there and its
 * removal; and Add project.
 */
export function ProjectScope() {
  const onSelect = (workspace: string) => useLayout.getState().setWorkspace(workspace);
  const { query: projects, all } = useSidebarProjects();
  const workspace = useLayout((s) => s.workspace);
  const marks = useProjectMarks(all, Boolean(projects.data));
  const [removing, setRemoving] = useState(false);
  const edges = useScrollEdges();
  const project = workspace === ALL_WORKSPACES ? undefined : projects.data?.find((each) => each.id === workspace);
  return (
    <>
      <Menu.Root>
        <Menu.Trigger className="title-crumb-link no-drag" aria-label={`Project: ${project?.name ?? ALL_PROJECTS}`}>
          <span className="project-scope-icon">{project ? <ProjectLogo project={project} size={18} /> : <Folders size={18} />}</span>
          <span className="project-scope-name">{project?.name ?? ALL_PROJECTS}</span>
        </Menu.Trigger>
        <Menu.Portal>
          <CoversPreview />
          <Menu.Positioner sideOffset={6} align="start" className="z-40" collisionPadding={8}>
            <Menu.Popup ref={floatingGround} className={cn(menuPopup, "sidebar-scope-menu")}>
              <div {...edges} className="sidebar-scope-list scroll-edges">
                <ScopeItem icon={<Folders size={18} />} name={ALL_PROJECTS} chosen={!project} onSelect={() => onSelect(ALL_WORKSPACES)} />
                {(projects.data ?? []).map((each) => (
                  <ScopeItem
                    key={each.id}
                    icon={<ProjectLogo project={each} size={18} />}
                    name={each.name}
                    chosen={each.id === project?.id}
                    mark={marks.get(each.id)}
                    onSelect={() => onSelect(each.id)}
                  />
                ))}
              </div>
              <Menu.Separator className={menuSeparator} />
              {project?.rootPath ? <ProjectActions project={project} onRemove={() => setRemoving(true)} /> : null}
              <Menu.Item className={cn(menuItem, "sidebar-scope-action")} onClick={() => useUi.getState().setImportProject(true)}>
                <FolderPlus size={13} /> Add project
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {removing && project ? <RemoveProjectDialog project={project} onClose={() => setRemoving(false)} /> : null}
    </>
  );
}

/** The chosen project's actions: a new task, its settings, and removal after a hairline. */
function ProjectActions({ project, onRemove }: { project: Pick<Project, "id" | "name">; onRemove: () => void }) {
  return (
    <>
      <Menu.Item className={cn(menuItem, "sidebar-scope-action")} onClick={() => useUi.getState().openNewTask(project.id)}>
        <Plus size={13} /> New task
      </Menu.Item>
      <Menu.Item className={cn(menuItem, "sidebar-scope-action")} onClick={() => openProject(project.id)}>
        <Settings size={13} /> Project settings
      </Menu.Item>
      <Menu.Separator className={menuSeparator} />
      <Menu.Item className={cn(menuItemDanger, "sidebar-scope-action")} onClick={onRemove}>
        <X size={13} /> Remove project…
      </Menu.Item>
      <Menu.Separator className={menuSeparator} />
    </>
  );
}
