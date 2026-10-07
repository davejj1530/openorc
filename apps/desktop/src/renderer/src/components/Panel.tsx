import { lazy, Suspense, useEffect, useState } from "react";
import { Maximize2, Minimize2, PanelRightClose, Plus } from "./icons";
import { ResizeHandle } from "./ResizeHandle";
import { IconButton, Tooltip } from "./ui";
import { cn } from "../lib/cn";
import { useLayout } from "../lib/layout";
import { usePanelSessions } from "../lib/panel-tabs";
import { toolPage, usePanelWorkspace } from "../lib/panel-workspace";
import { useTrafficLights, useWindowsControls } from "../lib/window";
import { pageLabel, type PanelContext } from "./panel-tools";
import { PanelContent } from "./PanelContent";
import { PanelNavigation } from "./PanelNavigation";
import { PanelNewTab } from "./PanelNewTab";
import { PanelTabs } from "./PanelTabs";

export { tabsFor, type PanelContext } from "./panel-tools";
const BrowserPanel = lazy(() => import("../panels/BrowserPanel").then((m) => ({ default: m.BrowserPanel })));

function useMountedThroughClose(open: boolean): boolean {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), 220);
    return () => clearTimeout(timer);
  }, [open]);
  return open || mounted;
}

type Workspace = ReturnType<typeof usePanelWorkspace>;

function PanelBody({ context, workspace, open }: { context: PanelContext; workspace: Workspace; open: boolean }) {
  const { page, tab, scope, navigate } = workspace;
  const previewUrls = useLayout((s) => s.previewUrls);
  const move = (delta: number) => {
    const next = tab.entries[tab.index + delta];
    if (next?.kind === "browser" && next.url && next.url !== previewUrls[tab.id]) window.openorc.browser.navigate(tab.id, next.url);
    usePanelSessions.getState().move(scope, delta);
  };
  const navigation = {
    canGoBack: tab.index > 0,
    canGoForward: tab.index < tab.entries.length - 1,
    onBack: () => move(-1),
    onForward: () => move(1),
    onHome: () => navigate({ kind: "newtab" }),
  };
  const onNavigate = (url: string) => navigate({ kind: "browser", url, title: "" });
  if (page.kind === "browser")
    return open ? (
      <BrowserPanel
        key={tab.id}
        id={tab.id}
        context={scope}
        defaultUrl={page.url}
        navigation={navigation}
        onPage={(state) => {
          if (!state.url || state.url === "about:blank") return;
          usePanelSessions.getState().reportBrowser(scope, tab.id, state.url, state.title);
          useLayout.getState().rememberPreviewUrl(tab.id, state.url);
        }}
      />
    ) : null;
  const recentUrls = [...new Set(Object.values(previewUrls).filter((url) => /^https?:\/\//i.test(url)))].reverse().slice(0, 4);
  return (
    <div className="h-full flex flex-col min-h-0">
      <PanelNavigation key={`${tab.id}:${tab.index}`} {...navigation} address={page.kind === "newtab" ? "" : pageLabel(page)} onNavigate={onNavigate} />
      <div className="flex-1 min-h-0">
        {page.kind === "newtab" ? (
          <PanelNewTab context={context} recentUrls={recentUrls} onTool={(tool) => navigate(toolPage(tool))} onNavigate={onNavigate} />
        ) : (
          <PanelContent context={context} page={page} onNavigate={navigate} />
        )}
      </div>
    </div>
  );
}

export function Panel({ context }: { context: PanelContext }) {
  const open = useLayout((s) => s.panelOpen);
  const expanded = useLayout((s) => s.panelExpanded) && open;
  const sidebarOpen = useLayout((s) => s.sidebarOpen);
  const mounted = useMountedThroughClose(open);
  const workspace = usePanelWorkspace(context);
  const windowsControls = useWindowsControls();
  const trafficLights = useTrafficLights();
  const { scope, session, tab } = workspace;
  const closeTab = (id: string) => {
    window.openorc.browser?.close?.(id);
    usePanelSessions.getState().close(scope, id);
    requestAnimationFrame(() => {
      const active = usePanelSessions.getState().sessions[scope]?.activeId;
      if (active) document.getElementById(`panel-tab-${active}`)?.focus();
    });
  };
  return (
    <>
      {open && !expanded ? <ResizeHandle edge="panel" /> : null}
      <aside
        className="panel-shell shrink-0 h-full"
        data-open={open}
        data-expanded={expanded || undefined}
        data-thread-owner={context.kind === "thread" ? context.thread.id : undefined}
        aria-hidden={!open}
        inert={!open}
        onKeyDown={(event) => {
          if (expanded && event.key === "Escape") useLayout.getState().setPanelExpanded(false);
        }}
      >
        <div className="panel-pane h-full flex flex-col">
          <header
            data-traffic-clearance={(!sidebarOpen && trafficLights) || undefined}
            className={cn(
              "panel-browser-header drag-region h-topbar shrink-0 flex items-center gap-1",
              expanded && !sidebarOpen && trafficLights ? "pl-traffic" : "pl-3",
              windowsControls ? "pr-controls" : "pr-2",
            )}
          >
            <PanelTabs session={session} onSelect={(id) => usePanelSessions.getState().select(scope, id)} onClose={closeTab} />
            <Tooltip label="New tab">
              <IconButton aria-label="New tab" className="no-drag shrink-0" onClick={() => usePanelSessions.getState().add(scope)}>
                <Plus size={15} />
              </IconButton>
            </Tooltip>
            <span className="flex-1" />
            <Tooltip label={expanded ? "Collapse panel" : "Expand panel"}>
              <IconButton
                aria-label={expanded ? "Collapse panel" : "Expand panel"}
                aria-pressed={expanded}
                className="no-drag shrink-0"
                onClick={() => useLayout.getState().setPanelExpanded(!expanded)}
              >
                {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </IconButton>
            </Tooltip>
            <Tooltip label="Hide panel">
              <IconButton aria-label="Hide panel" className="no-drag shrink-0" onClick={() => useLayout.getState().setPanel(false)}>
                <PanelRightClose size={15} />
              </IconButton>
            </Tooltip>
          </header>
          <div id="panel-tab-content" role="tabpanel" aria-labelledby={`panel-tab-${tab.id}`} className="panel-content flex-1 min-h-0">
            {mounted ? (
              <Suspense fallback={null}>
                <PanelBody context={context} workspace={workspace} open={open} />
              </Suspense>
            ) : null}
          </div>
        </div>
      </aside>
    </>
  );
}
