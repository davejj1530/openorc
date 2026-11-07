import { useState, type KeyboardEvent, type ReactNode } from "react";
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
import { markThread, projectInitials, workspaceMarks, workspaceSummary, type WorkspaceMark } from "../lib/workspace-rail";
import { ChevronDown, Plus, Settings, SquareStack, X } from "./icons";
import { menuItem, menuItemDanger, menuPopup, menuSeparator } from "./menu";
import { ProjectIcon } from "./ProjectIconPicker";
import { RemoveProjectDialog } from "./ProjectMenu";
import { useSidebarProjects } from "./SidebarThreadBrowser";
import { ThreadStatusIndicator } from "./ThreadStatusIndicator";
import { IconButton, Tooltip } from "./ui";

/**
 * Each project's mark, from the read of threads that need you across every project: the same read the list makes
 * while the rail is on All, so it costs nothing more there.
 */
function useWorkspaceMarks(projectIds: readonly string[], enabled: boolean): Map<string, WorkspaceMark> {
  const homes = new Set(useOrclings().map((orcling) => orcling.threadId));
  const now = useSidebarNow();
  const needsYou = useRpc(
    "threads.list",
    { projectIds: [...projectIds], filter: "active", orderBy: "activity", includeChildren: true, needsYou: true, limit: NEEDS_YOU_PAGE },
    { enabled, refetchInterval: 60_000 },
  );
  return workspaceMarks(needsYou.data, now, homes);
}

/** Up and down move between the rail's workspaces. */
function moveFocus(event: KeyboardEvent<HTMLUListElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".workspace-rail-item")];
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  event.preventDefault();
  items[Math.min(items.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
}

function RailItem({ label, name, tile, selected, mark, onSelect }: { label: string; name: string; tile: ReactNode; selected: boolean; mark?: WorkspaceMark; onSelect: () => void }) {
  const summary = workspaceSummary(mark);
  return (
    <li>
      <Tooltip
        label={
          <>
            <span className="block">{name}</span>
            {summary ? <span className="block text-ink-3">{summary}</span> : null}
          </>
        }
      >
        <button
          type="button"
          className="workspace-rail-item no-drag"
          aria-label={name}
          aria-description={summary || undefined}
          aria-current={selected || undefined}
          data-selected={selected || undefined}
          onClick={onSelect}
        >
          <span className="workspace-rail-tile">
            {tile}
            {mark ? (
              <span className="workspace-rail-mark">
                <ThreadStatusIndicator thread={markThread(mark.kind)} />
              </span>
            ) : null}
          </span>
          <span className="workspace-rail-label">{label}</span>
        </button>
      </Tooltip>
    </li>
  );
}

/**
 * The workspace rail beside the thread list: All, then each project by its initials with its most pressing thread's
 * mark in the tile's corner, and Add project at its foot. Choosing one lists only that project's threads.
 */
export function WorkspaceRail({ onSelect }: { onSelect: (workspace: string) => void }) {
  const { query: projects, all } = useSidebarProjects();
  const workspace = useLayout((s) => s.workspace);
  const marks = useWorkspaceMarks(all, Boolean(projects.data));
  return (
    <nav className="workspace-rail" aria-label="Workspaces">
      <ul className="workspace-rail-list" onKeyDown={moveFocus}>
        <RailItem label="All" name="All workspaces" tile={<SquareStack size={18} />} selected={workspace === ALL_WORKSPACES} onSelect={() => onSelect(ALL_WORKSPACES)} />
        {(projects.data ?? []).map((project) => (
          <RailItem
            key={project.id}
            label={project.name}
            name={project.name}
            tile={<span className="workspace-rail-initials">{projectInitials(project.name)}</span>}
            selected={workspace === project.id}
            mark={marks.get(project.id)}
            onSelect={() => onSelect(project.id)}
          />
        ))}
      </ul>
      <Tooltip label="Add project">
        <IconButton size="lg" aria-label="Add project" className="workspace-rail-add no-drag" onClick={() => useUi.getState().setImportProject(true)}>
          <Plus size={16} />
        </IconButton>
      </Tooltip>
    </nav>
  );
}

/** The project's actions under its name: its settings, a new task, and removal. */
function ProjectActions({ project }: { project: Pick<Project, "id" | "name" | "rootPath"> }) {
  const [removing, setRemoving] = useState(false);
  return (
    <>
      <Menu.Root>
        <Menu.Trigger className="sidebar-workspace-name no-drag" aria-label={`${project.name}, project actions`}>
          <WorkspaceNameLabel icon={<ProjectIcon rootPath={project.rootPath} />} name={project.name} />
          <ChevronDown size={14} className="sidebar-workspace-name-chevron" />
        </Menu.Trigger>
        <Menu.Portal>
          <CoversPreview />
          <Menu.Positioner sideOffset={6} align="start" className="z-40" collisionPadding={8}>
            <Menu.Popup ref={floatingGround} className={menuPopup}>
              <Menu.Item className={menuItem} onClick={() => openProject(project.id, "settings")}>
                <Settings size={13} /> Project settings
              </Menu.Item>
              <Menu.Item className={menuItem} onClick={() => useUi.getState().openNewTask(project.id)}>
                <Plus size={13} /> New task
              </Menu.Item>
              <Menu.Separator className={menuSeparator} />
              <Menu.Item className={menuItemDanger} onClick={() => setRemoving(true)}>
                <X size={13} /> Remove project…
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {removing ? <RemoveProjectDialog project={project} onClose={() => setRemoving(false)} /> : null}
    </>
  );
}

function WorkspaceNameLabel({ icon, name }: { icon: ReactNode; name: string }) {
  return (
    <>
      <span className="sidebar-workspace-name-icon">{icon}</span>
      <span className="sidebar-workspace-name-label">{name}</span>
    </>
  );
}

/** The thread list's first row: the workspace the rail chose, opening its project's actions; All has none. */
export function WorkspaceName() {
  const workspace = useLayout((s) => s.workspace);
  const projects = useRpc("projects.list", {});
  const project = workspace === ALL_WORKSPACES ? undefined : projects.data?.find((each) => each.id === workspace);
  if (project) return <ProjectActions project={project} />;
  return (
    <div className="sidebar-workspace-name">
      <WorkspaceNameLabel icon={<SquareStack size={14} />} name="All workspaces" />
    </div>
  );
}
