import { useState, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { NEEDS_YOU_PAGE, useSidebarNow } from "@openorc/client";
import type { Project } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { useRpc } from "../lib/client";
import { ALL_WORKSPACES, useLayout } from "../lib/layout";
import { useOrclings } from "../lib/orclings";
import { openProject } from "../lib/router";
import { useUi } from "../lib/ui";
import { floatingGround } from "../lib/use-anchor-ground";
import { useScrollEdges } from "../lib/use-scroll-edges";
import { cn } from "../lib/cn";
import { markThread, workspaceMarks, workspaceSummary, type WorkspaceMark } from "../lib/workspace-rail";
import { Check, ChevronDown, Plus, Settings, SquareStack, X } from "./icons";
import { menuItem, menuItemDanger, menuPopup, menuSeparator } from "./menu";
import { ProjectIcon } from "./ProjectIconPicker";
import { RemoveProjectDialog } from "./ProjectMenu";
import { useSidebarProjects } from "./SidebarThreadBrowser";
import { ThreadStatusIndicator } from "./ThreadStatusIndicator";

/**
 * Each project's mark, from the read of threads that need you across every project: the same read the list makes
 * while it shows every project, so it costs nothing more there.
 */
export function useWorkspaceMarks(projectIds: readonly string[], enabled: boolean): Map<string, WorkspaceMark> {
  const homes = new Set(useOrclings().map((orcling) => orcling.threadId));
  const now = useSidebarNow();
  const needsYou = useRpc(
    "threads.list",
    { projectIds: [...projectIds], filter: "active", orderBy: "activity", includeChildren: true, needsYou: true, limit: NEEDS_YOU_PAGE },
    { enabled, refetchInterval: 60_000 },
  );
  return workspaceMarks(needsYou.data, now, homes);
}

const ALL_PROJECTS = "All projects";

function ScopeName({ icon, name }: { icon: ReactNode; name: string }) {
  return (
    <>
      <span className="sidebar-workspace-name-icon">{icon}</span>
      <span className="sidebar-workspace-name-label">{name}</span>
    </>
  );
}

/** The chosen row, scrolled to the middle of the projects as the menu opens when they run past it. */
const inView = (row: HTMLElement | null) => row?.scrollIntoView?.({ block: "center" });

/** One choice of whose threads to list: chosen or not, the project's icon and name, then its most pressing thread's mark. */
function ScopeItem({ icon, name, chosen, mark, onSelect }: { icon: ReactNode; name: string; chosen: boolean; mark?: WorkspaceMark | undefined; onSelect: () => void }) {
  const summary = workspaceSummary(mark);
  return (
    <Menu.Item ref={chosen ? inView : undefined} className={menuItem} aria-description={summary || undefined} onClick={onSelect}>
      <Check size={13} className={chosen ? "text-accent-ink" : "text-transparent"} />
      <span className="sidebar-scope-icon">{icon}</span>
      <span className="sidebar-scope-name">{name}</span>
      {mark ? (
        <span className="sidebar-scope-mark" title={summary}>
          <ThreadStatusIndicator thread={markThread(mark.kind)} />
        </span>
      ) : null}
    </Menu.Item>
  );
}

/**
 * The thread list's first row: whose threads it lists. It opens on All projects, then each project with its most
 * pressing thread's mark; the chosen project's settings, a new task there and its removal; and Add project. As a
 * `crumb` it is the project's name at the head of a screen's title, opening the same menu.
 */
export function ProjectFilter({ onSelect, crumb = false }: { onSelect: (workspace: string) => void; crumb?: boolean }) {
  const { query: projects, all } = useSidebarProjects();
  const workspace = useLayout((s) => s.workspace);
  const marks = useWorkspaceMarks(all, Boolean(projects.data));
  const [removing, setRemoving] = useState(false);
  const edges = useScrollEdges();
  const project = workspace === ALL_WORKSPACES ? undefined : projects.data?.find((each) => each.id === workspace);
  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          className={cn("no-drag", crumb ? "scope-crumb-project" : "sidebar-workspace-name")}
          aria-label={crumb ? `Project: ${project?.name ?? ALL_PROJECTS}` : `Threads in ${project?.name ?? "all projects"}`}
        >
          <ScopeName icon={project ? <ProjectIcon rootPath={project.rootPath} /> : <SquareStack size={14} />} name={project?.name ?? ALL_PROJECTS} />
          {crumb ? null : <ChevronDown size={14} className="sidebar-workspace-name-chevron" />}
        </Menu.Trigger>
        <Menu.Portal>
          <CoversPreview />
          <Menu.Positioner sideOffset={6} align="start" className="z-40" collisionPadding={8}>
            <Menu.Popup ref={floatingGround} className={cn(menuPopup, "sidebar-scope-menu")}>
              <div {...edges} className="sidebar-scope-list scroll-edges">
                <ScopeItem icon={<SquareStack size={13} />} name={ALL_PROJECTS} chosen={!project} onSelect={() => onSelect(ALL_WORKSPACES)} />
                {(projects.data ?? []).map((each) => (
                  <ScopeItem
                    key={each.id}
                    icon={<ProjectIcon rootPath={each.rootPath} />}
                    name={each.name}
                    chosen={each.id === project?.id}
                    mark={marks.get(each.id)}
                    onSelect={() => onSelect(each.id)}
                  />
                ))}
              </div>
              <Menu.Separator className={menuSeparator} />
              {project ? <ProjectActions project={project} onRemove={() => setRemoving(true)} /> : null}
              <Menu.Item className={cn(menuItem, "sidebar-scope-action")} onClick={() => useUi.getState().setImportProject(true)}>
                <Plus size={13} /> Add project
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {removing && project ? <RemoveProjectDialog project={project} onClose={() => setRemoving(false)} /> : null}
    </>
  );
}

/** The chosen project's actions: its settings, a new task, and removal. */
function ProjectActions({ project, onRemove }: { project: Pick<Project, "id" | "name">; onRemove: () => void }) {
  return (
    <>
      <Menu.Item className={cn(menuItem, "sidebar-scope-action")} onClick={() => openProject(project.id)}>
        <Settings size={13} /> Project settings
      </Menu.Item>
      <Menu.Item className={cn(menuItem, "sidebar-scope-action")} onClick={() => useUi.getState().openNewTask(project.id)}>
        <Plus size={13} /> New task
      </Menu.Item>
      <Menu.Item className={cn(menuItemDanger, "sidebar-scope-action")} onClick={onRemove}>
        <X size={13} /> Remove project…
      </Menu.Item>
      <Menu.Separator className={menuSeparator} />
    </>
  );
}
