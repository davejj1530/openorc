import type { ReactNode } from "react";

import { PanelIcon } from "./icons";
import { cn } from "../lib/cn";
import { useLayout, type PanelSide } from "../lib/layout";
import { WindowNav } from "./Sidebar";
import { useWindowCorner } from "../lib/navigation-column";
import { IconButton, Tooltip } from "./ui";
import { useTrafficLights, useWindowsControls } from "../lib/window";

/**
 * The header's side padding. The window's outermost headers clear the native controls; tabs start 8px in, a thread's
 * header otherwise sits 20px in with its round tools 8px from the edge, and page headers keep 12px on both sides.
 */
function headerInset({ corner, rightmost, besideColumn, thread, tabs }: { corner: "lights" | "wordmark" | null; rightmost: boolean; besideColumn: boolean; thread?: boolean; tabs?: boolean }): string {
  const left = cn(tabs && "pl-2", !tabs && thread && "pl-5", !tabs && !thread && "pl-3");
  // A thread header keeps 8px at the window's edge, and 12px from the panel or pane beside it.
  const right = thread && !besideColumn ? "pr-2" : "pr-3";
  return cn(corner === "lights" && "pl-traffic", corner === "wordmark" && "pl-wordmark", !corner && left, rightmost ? "pr-controls" : right);
}

/**
 * Where the header sits in the work row. The first carries the window navigation; a panel docked
 * on the left comes before it. The last clears the Windows controls unless a panel follows it.
 */
function headerEnds({ inSplit, panelShown, panelSide, rightmost }: { inSplit?: boolean; panelShown: boolean; panelSide: PanelSide; rightmost?: boolean }) {
  return { first: !inSplit && !(panelShown && panelSide === "left"), last: rightmost ?? !(panelShown && panelSide === "right") };
}

/**
 * The main column's header: the screen's title. A plain-text title is the page's heading. The project in view is the
 * sidebar filter's, so headers carry no project of their own.
 * Window navigation stays here. With the sidebar hidden this is the window's
 * leftmost header, so it also clears the native window controls.
 * When a panel is available its toggle lives here, showing it or hiding it, so
 * the third column is one click away either way (the panel's own Hide shows only
 * while it covers this header). A panel docked on the left takes the window
 * navigation into its own header.
 */
export function TopBar({
  children,
  actions,
  className,
  panel,
  inSplit,
  tabs,
  windowDragSurface,
  rightmost: isRightmost,
}: {
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  panel?: boolean;
  inSplit?: boolean;
  /** The header leads with the work column's tabs. */
  tabs?: boolean;
  windowDragSurface?: boolean;
  rightmost?: boolean;
}) {
  const sidebarOpen = useLayout((s) => s.sidebarOpen);
  const panelOpen = useLayout((s) => s.panelOpen);
  const panelSide = useLayout((s) => s.panelSide);
  const setPanel = useLayout((s) => s.setPanel);
  const trafficLights = useTrafficLights();
  const windowsControls = useWindowsControls();
  const { first, last: rightmost } = headerEnds({ inSplit, panelShown: Boolean(panel && panelOpen), panelSide, rightmost: isRightmost });
  // Only the window's first header clears what holds the corner, and only its rightmost clears the Windows controls.
  const windowCorner = useWindowCorner();
  const corner = first ? windowCorner : null;
  const panelLabel = panelOpen ? "Hide panel" : "Show panel";
  return (
    <header
      data-window-navigation={first || undefined}
      data-traffic-lights={(trafficLights && first) || undefined}
      className={cn(
        "drag-region app-topbar h-topbar shrink-0 flex items-center justify-between",
        windowDragSurface ? "thread-header" : "gap-2",
        headerInset({ corner, rightmost: rightmost && windowsControls, besideColumn: !rightmost, thread: windowDragSurface, tabs }),
        className,
      )}
    >
      {/* Native regions follow declaration order: controls must follow this layer. */}
      {windowDragSurface ? <span className="thread-header-drag-surface" aria-hidden="true" /> : null}
      <div className="flex items-center gap-2 min-w-0 flex-1 text-base truncate">
        {first ? (
          <span className="workspace-window-nav flex items-center mr-1" data-sidebar-open={sidebarOpen}>
            <WindowNav open={sidebarOpen} />
          </span>
        ) : null}
        {typeof children === "string" ? <h1 className="inline-flex items-center h-7 px-1 truncate text-ink">{children}</h1> : children}
      </div>
      {/* A clipped navigation control can still contribute its full native no-drag
          rectangle. Redeclare this gap after the clipped group, before actions. */}
      {windowDragSurface ? <span className="thread-header-gap w-2 shrink-0 self-stretch" aria-hidden="true" /> : null}
      <div className="topbar-actions flex shrink-0 items-center gap-1">
        {actions}
        {panel ? (
          <Tooltip label={panelLabel}>
            <IconButton onClick={() => setPanel(!panelOpen)} aria-label={panelLabel} aria-pressed={panelOpen}>
              <PanelIcon side={panelSide} size={16} />
            </IconButton>
          </Tooltip>
        ) : null}
      </div>
    </header>
  );
}
