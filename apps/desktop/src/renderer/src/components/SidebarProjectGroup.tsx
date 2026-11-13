import { useRef, useState, type ReactNode, type RefObject } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import type { GroupProject } from "@openorc/client";
import { WORKSPACE_ID } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { cn } from "../lib/cn";
import { newThread, openProject } from "../lib/router";
import { useUi } from "../lib/ui";
import { floatingGround } from "../lib/use-anchor-ground";
import { ChevronRight, Image as ImageIcon, PenSquare, Plus, Settings, X } from "./icons";
import { menuItem, menuItemDanger, menuPopup, menuSeparator } from "./menu";
import { ProjectIconChooser } from "./ProjectIconPicker";
import { RemoveProjectDialog } from "./ProjectMenu";
import { Tooltip } from "./ui";

const startThread = (projectId: string) => {
  newThread(projectId);
  dismissCompactNavigation();
};

/**
 * One project's part of the thread list: its name as a quiet label that folds the group, with how many of its threads
 * wait on the person and, on hover, New thread there; then its rows, and "Show N more" while some are past the page. A
 * right click on the label gives the project's own actions.
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
  return (
    <section className="sidebar-section sidebar-project" data-open={open || undefined} aria-label={project.name}>
      <div className="sidebar-project-head">
        <ProjectActions project={project} anchor={label}>
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
            <span className="sidebar-project-name" data-tip={project.name}>
              {project.name}
            </span>
            <ChevronRight size={12} className="sidebar-section-chevron" />
            {waiting ? <span className="sidebar-count tabular">{waiting}</span> : null}
          </ContextMenu.Trigger>
        </ProjectActions>
        <Tooltip label="New thread">
          <button type="button" aria-label={`New thread in ${project.name}`} className="sidebar-project-new no-drag" onClick={() => startThread(project.id)}>
            <Plus size={14} />
          </button>
        </Tooltip>
      </div>
      <div className={cn("sidebar-thread-list", animate && open && "motion-stagger")}>
        {children}
        {open && hidden ? (
          <button type="button" className="browser-load-more" onClick={onShowMore}>
            Show {hidden} more
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** The project's own actions on its label's right click: a new thread or task there, its icon, its settings and its removal. */
function ProjectActions({ project, anchor, children }: { project: GroupProject; anchor: RefObject<HTMLButtonElement | null>; children: ReactNode }) {
  const [choosing, setChoosing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const own = project.id !== WORKSPACE_ID;
  return (
    <>
      <ContextMenu.Root>
        {children}
        <ContextMenu.Portal>
          <CoversPreview />
          <ContextMenu.Positioner collisionPadding={8} className="z-40">
            <ContextMenu.Popup ref={floatingGround} className={menuPopup}>
              <ContextMenu.Item className={menuItem} onClick={() => startThread(project.id)}>
                <PenSquare size={13} /> New thread
              </ContextMenu.Item>
              {own ? (
                <>
                  <ContextMenu.Item className={menuItem} onClick={() => useUi.getState().openNewTask(project.id)}>
                    <Plus size={13} /> New task
                  </ContextMenu.Item>
                  <ContextMenu.Separator className={menuSeparator} />
                  <ContextMenu.Item className={menuItem} disabled={!project.rootPath} onClick={() => setChoosing(true)}>
                    <ImageIcon size={13} /> Choose icon…
                  </ContextMenu.Item>
                  <ContextMenu.Item className={menuItem} onClick={() => openProject(project.id)}>
                    <Settings size={13} /> Project settings
                  </ContextMenu.Item>
                  <ContextMenu.Separator className={menuSeparator} />
                  <ContextMenu.Item className={menuItemDanger} onClick={() => setRemoving(true)}>
                    <X size={13} /> Remove project…
                  </ContextMenu.Item>
                </>
              ) : null}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {own && project.rootPath ? <ProjectIconChooser rootPath={project.rootPath} open={choosing} onOpenChange={setChoosing} anchor={anchor} /> : null}
      {removing ? <RemoveProjectDialog project={project} onClose={() => setRemoving(false)} /> : null}
    </>
  );
}
