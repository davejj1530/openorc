import { useRef, useState, type ReactNode, type RefObject } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import type { GroupProject } from "@openorc/client";
import { WORKSPACE_ID } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { cn } from "../lib/cn";
import { newThread, openProject } from "../lib/router";
import { useUi } from "../lib/ui";
import { floatingGround } from "../lib/use-anchor-ground";
import { ChevronRight, Cloud, Globe, Image as ImageIcon, MoreHorizontal, PenSquare, Plus, Settings, X } from "./icons";
import { menuItem, menuItemDanger, menuPopup, menuSeparator } from "./menu";
import { ProjectIcon, ProjectIconChooser } from "./ProjectIconPicker";
import { RemoveProjectDialog } from "./ProjectMenu";
import type { MenuParts } from "./ThreadActions";
import { Tooltip } from "./ui";

const startThread = (projectId: string) => {
  newThread(projectId);
  dismissCompactNavigation();
};

/**
 * One project's part of the thread list: its mark and name as a quiet label that folds the group, with how many of its threads
 * wait on the person and, on hover or focus, the project's actions and New thread there; then its rows, and "Show N more"
 * while some are past the page. A right click on the label gives the same actions.
 */
export function SidebarProjectGroup({
  project,
  open,
  waiting,
  hidden,
  onToggle,
  onShowMore,
  children,
}: {
  project: GroupProject;
  open: boolean;
  waiting: number;
  /** How many of its threads are past the page, for "Show N more". */
  hidden: number;
  onToggle: () => void;
  onShowMore: () => void;
  children: ReactNode;
}) {
  const [animate, setAnimate] = useState(false);
  const label = useRef<HTMLButtonElement>(null);
  const actions = useProjectDialogs(project, label);
  return (
    <section className="sidebar-section sidebar-project" data-open={open || undefined} aria-label={project.name}>
      <div className="sidebar-project-head">
        <ProjectActions project={project} actions={actions}>
          <ContextMenu.Trigger
            render={<button ref={label} type="button" />}
            aria-expanded={open}
            aria-label={waiting ? `${project.name}, ${waiting} waiting` : project.name}
            className="sidebar-section-toggle no-drag"
            onClick={() => {
              setAnimate(true);
              onToggle();
            }}
          >
            <span className="sidebar-project-mark" aria-hidden="true">
              <ProjectMark project={project} />
            </span>
            <span className="sidebar-project-name" data-tip={project.name}>
              {project.name}
            </span>
            <ChevronRight size={12} className="sidebar-section-chevron" />
            {waiting ? <span className="sidebar-count tabular">{waiting}</span> : null}
          </ContextMenu.Trigger>
        </ProjectActions>
        {project.cloud ? null : (
          <div className="sidebar-project-tools">
            {project.id !== WORKSPACE_ID ? <ProjectMoreMenu project={project} actions={actions} /> : null}
            <Tooltip label="New thread">
              <button type="button" aria-label={`New thread in ${project.name}`} className="sidebar-project-tool no-drag" onClick={() => startThread(project.id)}>
                <PenSquare size={14} />
              </button>
            </Tooltip>
          </div>
        )}
      </div>
      <div className={cn("sidebar-thread-list", animate && open && "motion-stagger")}>
        {children}
        {open && hidden ? (
          <button type="button" className="browser-load-more" onClick={onShowMore}>
            Show {hidden} more
          </button>
        ) : null}
      </div>
      {actions.dialogs}
    </section>
  );
}

/** A project's mark: its chosen or detected icon, the cloud for a project only OpenOrc Cloud has, else No project's globe. */
function ProjectMark({ project }: { project: GroupProject }) {
  if (project.rootPath) return <ProjectIcon rootPath={project.rootPath} size={14} />;
  return project.cloud ? <Cloud size={14} /> : <Globe size={14} />;
}

type ProjectDialogs = ReturnType<typeof useProjectDialogs>;

/** The dialogs a project's actions open, shared by its label's right click and the More button at its end. */
function useProjectDialogs(project: GroupProject, anchor: RefObject<HTMLButtonElement | null>) {
  const [choosing, setChoosing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const own = project.id !== WORKSPACE_ID;
  return {
    choose: () => setChoosing(true),
    remove: () => setRemoving(true),
    dialogs: (
      <>
        {own && project.rootPath ? <ProjectIconChooser rootPath={project.rootPath} open={choosing} onOpenChange={setChoosing} anchor={anchor} /> : null}
        {removing ? <RemoveProjectDialog project={project} onClose={() => setRemoving(false)} /> : null}
      </>
    ),
  };
}

/** Every action a project has, as menu items: a new thread or task there, its icon, its settings and its removal. */
function ProjectMenuItems({ project, parts: M, onChoose, onRemove }: { project: GroupProject; parts: MenuParts; onChoose: () => void; onRemove: () => void }) {
  const own = project.id !== WORKSPACE_ID;
  return (
    <>
      <M.Item className={menuItem} onClick={() => startThread(project.id)}>
        <PenSquare size={13} /> New thread
      </M.Item>
      {own ? (
        <>
          <M.Item className={menuItem} onClick={() => useUi.getState().openNewTask(project.id)}>
            <Plus size={13} /> New task
          </M.Item>
          <M.Separator className={menuSeparator} />
          <M.Item className={menuItem} disabled={!project.rootPath} onClick={onChoose}>
            <ImageIcon size={13} /> Choose icon…
          </M.Item>
          <M.Item className={menuItem} onClick={() => openProject(project.id)}>
            <Settings size={13} /> Project settings
          </M.Item>
          <M.Separator className={menuSeparator} />
          <M.Item className={menuItemDanger} onClick={onRemove}>
            <X size={13} /> Remove project…
          </M.Item>
        </>
      ) : null}
    </>
  );
}

/** The project's actions on its label's right click, or the context menu key while the label has focus. */
function ProjectActions({ project, actions, children }: { project: GroupProject; actions: ProjectDialogs; children: ReactNode }) {
  return (
    <ContextMenu.Root disabled={project.cloud}>
      {children}
      <ContextMenu.Portal>
        <CoversPreview />
        <ContextMenu.Positioner collisionPadding={8} className="z-40">
          <ContextMenu.Popup ref={floatingGround} className={menuPopup}>
            <ProjectMenuItems project={project} parts={ContextMenu as unknown as MenuParts} onChoose={actions.choose} onRemove={actions.remove} />
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** The same actions from a button at the label's end, shown on hover or focus, so the keyboard and a click reach them. */
function ProjectMoreMenu({ project, actions }: { project: GroupProject; actions: ProjectDialogs }) {
  return (
    <Menu.Root>
      <Menu.Trigger render={<button type="button" />} aria-label={`More for ${project.name}`} className="sidebar-project-tool no-drag">
        <MoreHorizontal size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={4} align="start" collisionPadding={8} className="z-40">
          <Menu.Popup ref={floatingGround} className={menuPopup}>
            <ProjectMenuItems project={project} parts={Menu as unknown as MenuParts} onChoose={actions.choose} onRemove={actions.remove} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
