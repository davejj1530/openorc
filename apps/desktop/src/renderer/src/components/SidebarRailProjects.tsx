import { useRef, useState } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import type { Project } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { ALL_WORKSPACES, useLayout } from "../lib/layout";
import { openProject } from "../lib/router";
import { useUi } from "../lib/ui";
import { useScrollEdges } from "../lib/use-scroll-edges";
import { floatingGround } from "../lib/use-anchor-ground";
import { markThread, workspaceSummary, type WorkspaceMark } from "../lib/workspace-rail";
import { Image as ImageIcon, Plus, Settings, SquareStack, X } from "./icons";
import { menuItem, menuItemDanger, menuPopup, menuSeparator } from "./menu";
import { ProjectIcon, ProjectIconChooser } from "./ProjectIconPicker";
import { RemoveProjectDialog } from "./ProjectMenu";
import { useSidebarProjects } from "./SidebarThreadBrowser";
import { useWorkspaceMarks } from "./SidebarWorkspaces";
import { ThreadStatusIndicator } from "./ThreadStatusIndicator";
import { RAIL_ICON } from "./sidebar-screens";
import { Tooltip } from "./ui";

/** One project on the rail: its own icon on a round tile, its name and what its threads have to say on hover, and its most pressing thread's mark in the corner. A right click chooses its icon. */
function RailProject({ project, selected, mark, onSelect }: { project: Pick<Project, "id" | "name" | "rootPath">; selected: boolean; mark: WorkspaceMark | undefined; onSelect: () => void }) {
  const tile = useRef<HTMLButtonElement>(null);
  const [choosing, setChoosing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const summary = workspaceSummary(mark);
  return (
    <li>
      <ContextMenu.Root>
        <Tooltip
          side="right"
          label={
            <>
              <span className="block">{project.name}</span>
              {summary ? <span className="block text-ink-3">{summary}</span> : null}
            </>
          }
        >
          <ContextMenu.Trigger
            render={<button ref={tile} type="button" />}
            className="sidebar-dock-button sidebar-rail-project no-drag"
            aria-label={project.name}
            aria-description={summary || undefined}
            aria-current={selected || undefined}
            data-selected={selected || undefined}
            onClick={onSelect}
          >
            <ProjectIcon rootPath={project.rootPath} size={RAIL_ICON} />
            {mark ? (
              <span className="sidebar-rail-mark">
                <ThreadStatusIndicator thread={markThread(mark.kind)} />
              </span>
            ) : null}
          </ContextMenu.Trigger>
        </Tooltip>
        <ContextMenu.Portal>
          <CoversPreview />
          <ContextMenu.Positioner collisionPadding={8} className="z-40">
            <ContextMenu.Popup ref={floatingGround} className={menuPopup}>
              <ContextMenu.Item className={menuItem} onClick={() => setChoosing(true)}>
                <ImageIcon size={13} /> Choose icon…
              </ContextMenu.Item>
              <ContextMenu.Item className={menuItem} onClick={() => openProject(project.id)}>
                <Settings size={13} /> Project settings
              </ContextMenu.Item>
              <ContextMenu.Separator className={menuSeparator} />
              <ContextMenu.Item className={menuItemDanger} onClick={() => setRemoving(true)}>
                <X size={13} /> Remove project…
              </ContextMenu.Item>
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <ProjectIconChooser rootPath={project.rootPath} open={choosing} onOpenChange={setChoosing} anchor={tile} />
      {removing ? <RemoveProjectDialog project={project} onClose={() => setRemoving(false)} /> : null}
    </li>
  );
}

/**
 * The rail's Projects button, and while it is open the projects under it, each choosing whose threads the list shows;
 * the chosen one again goes back to all of them. They sit in a well of their own that scrolls past a few, with Add
 * project under it.
 */
export function RailProjects({ onSelect }: { onSelect: (workspace: string) => void }) {
  const open = useLayout((s) => s.railProjects);
  const workspace = useLayout((s) => s.workspace);
  const { query: projects, all } = useSidebarProjects();
  const marks = useWorkspaceMarks(all, open && Boolean(projects.data));
  const label = open ? "Hide projects" : "Show projects";
  const edges = useScrollEdges();
  return (
    <>
      <Tooltip label={label} side="right">
        <button type="button" aria-label={label} aria-expanded={open} className="sidebar-dock-button no-drag" data-open={open || undefined} onClick={() => useLayout.getState().setRailProjects(!open)}>
          <SquareStack size={RAIL_ICON} />
        </button>
      </Tooltip>
      {open ? (
        <>
          <div data-plane className="sidebar-rail-projects">
            <ul {...edges} className="sidebar-rail-projects-list scroll-edges" aria-label="Projects">
              {(projects.data ?? []).map((project) => (
                <RailProject
                  key={project.id}
                  project={project}
                  selected={workspace === project.id}
                  mark={marks.get(project.id)}
                  onSelect={() => onSelect(workspace === project.id ? ALL_WORKSPACES : project.id)}
                />
              ))}
            </ul>
          </div>
          <Tooltip label="Add project" side="right">
            <button type="button" aria-label="Add project" className="sidebar-dock-button no-drag" onClick={() => useUi.getState().setImportProject(true)}>
              <Plus size={RAIL_ICON} />
            </button>
          </Tooltip>
        </>
      ) : null}
    </>
  );
}
