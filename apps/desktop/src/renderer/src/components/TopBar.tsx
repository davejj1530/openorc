import type { ReactNode } from "react";
import { WORKSPACE_ID } from "@openorc/protocol";

function displayedProjectName(override: string | null | undefined, selectedId: string | null, projects: readonly { id: string; name: string }[] | undefined): string {
  if (override != null) return override;
  if (selectedId === null) return "All projects";
  if (selectedId === WORKSPACE_ID) return "Workspace";
  return projects?.find((project) => project.id === selectedId)?.name ?? "Project";
}
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronDown, PanelRight } from "./icons";
import { cn } from "../lib/cn";
import { useLayout } from "../lib/layout";
import { WindowNav } from "./Sidebar";
import { IconButton, Tooltip } from "./ui";
import { useTrafficLights, useWindowsControls } from "../lib/window";
import { useRpc } from "../lib/query";
import { menuItem, menuPopup } from "./ThreadActions";
import { CoversPreview } from "../lib/browser-preview";

/**
 * The main column's header: the screen's title with a quiet project switcher.
 * Window navigation stays here. With the sidebar hidden this is the window's
 * leftmost header, so it also clears the native window controls.
 * When a panel is available but closed, its toggle lives here so the third
 * column is one click away.
 */
export function TopBar({
  children,
  actions,
  className,
  panel,
  inSplit,
  projectId,
  projectName,
  showProject = true,
  onProjectChange,
  onPanelToggle,
  panelActive,
  windowDragSurface,
  rightmost: isRightmost,
}: {
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  panel?: boolean;
  inSplit?: boolean;
  projectId?: string | null;
  projectName?: string | null;
  showProject?: boolean;
  onProjectChange?: (id: string | null) => void;
  onPanelToggle?: () => void;
  panelActive?: boolean;
  windowDragSurface?: boolean;
  rightmost?: boolean;
}) {
  const sidebarOpen = useLayout((s) => s.sidebarOpen);
  const panelOpen = useLayout((s) => s.panelOpen);
  const setPanel = useLayout((s) => s.setPanel);
  const trafficLights = useTrafficLights();
  const windowsControls = useWindowsControls();
  // Only the window's leftmost header clears the traffic lights, and only its rightmost clears the Windows controls.
  const leftmost = !sidebarOpen && !inSplit;
  const rightmost = isRightmost ?? !(panel && panelOpen);
  const panelLabel = panelActive ? "Hide panel" : "Show panel";
  return (
    <header
      className={cn(
        "drag-region app-topbar h-topbar shrink-0 flex items-center justify-between",
        windowDragSurface ? "thread-header" : "gap-2",
        leftmost && trafficLights ? "pl-traffic" : "pl-3",
        rightmost && windowsControls ? "pr-controls" : "pr-3",
        className,
      )}
    >
      {/* Native regions follow declaration order: controls must follow this layer. */}
      {windowDragSurface ? <span className="thread-header-drag-surface" aria-hidden="true" /> : null}
      <div className="flex items-center gap-2 min-w-0 flex-1 text-base font-medium truncate">
        {inSplit ? null : (
          <span className="flex items-center gap-1 mr-1">
            <WindowNav open={sidebarOpen} />
          </span>
        )}
        {typeof children === "string" ? <span className="inline-flex items-center h-7 px-1 truncate text-ink">{children}</span> : children}
        {showProject && <HeaderProjectPicker projectId={projectId} projectName={projectName} onProjectChange={onProjectChange} />}
      </div>
      {/* A clipped navigation control can still contribute its full native no-drag
          rectangle. Redeclare this gap after the clipped group, before actions. */}
      {windowDragSurface ? <span className="thread-header-gap w-2 shrink-0 self-stretch" aria-hidden="true" /> : null}
      <div className="topbar-actions flex shrink-0 items-center gap-1">
        {actions}
        {panel && (onPanelToggle || !panelOpen) ? (
          <Tooltip label={panelLabel}>
            <IconButton onClick={onPanelToggle ?? (() => setPanel(true))} aria-label={panelLabel} aria-pressed={panelActive}>
              <PanelRight size={15} />
            </IconButton>
          </Tooltip>
        ) : null}
      </div>
    </header>
  );
}

function HeaderProjectPicker({ projectId, projectName, onProjectChange }: { projectId?: string | null; projectName?: string | null; onProjectChange?: (id: string | null) => void }) {
  const layoutProjectId = useLayout((s) => s.projectId);
  const setProject = useLayout((s) => s.setProject);
  const projects = useRpc("projects.list", {});
  const selectedProjectId = projectId === undefined ? layoutProjectId : projectId;
  const name = displayedProjectName(projectName, selectedProjectId, projects.data);
  const projectOptions = [...(projectId === undefined ? [{ id: null, name: "All projects" }] : []), { id: WORKSPACE_ID, name: "Workspace" }, ...(projects.data ?? [])];
  const chooseProject = (id: string | null) => {
    setProject(id);
    onProjectChange?.(id);
  };
  return (
    <Menu.Root>
      <Menu.Trigger className="header-chip no-drag shrink-0" title={`Switch project: ${name}`} aria-label={`Project: ${name}. Switch project`}>
        <span className="truncate">{name}</span>
        <ChevronDown size={12} className="shrink-0" />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={6} align="start" className="z-40" collisionPadding={8}>
          <Menu.Popup className={menuPopup}>
            {projectOptions.map((option) => (
              <Menu.Item key={option.id ?? "all"} className={menuItem} onClick={() => chooseProject(option.id)}>
                <Check size={13} className={selectedProjectId === option.id ? "text-ink" : "text-transparent"} />
                <span className="truncate">{option.name}</span>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
