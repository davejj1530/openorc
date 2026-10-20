import { lazy, Suspense, useEffect, useState } from "react";
import { ResizeHandle } from "./ResizeHandle";
import { PANE_MS } from "../lib/motion";
import { requestFilesFocus, useFilesHost } from "../lib/files-tool";
import { useLayout } from "../lib/layout";
import { usePanelSessions } from "../lib/panel-tabs";
import { toolPage, usePanelWorkspace } from "../lib/panel-workspace";
import { useTrafficLights, useWindowsControls } from "../lib/window";
import { panelFileScope, terminalId, type PanelContext } from "./panel-tools";
import { PanelContent } from "./PanelContent";
import { PanelNavigation } from "./PanelNavigation";
import { PanelNewTab } from "./PanelNewTab";
import { PanelHeader } from "./PanelHeader";
import { useFileTabClosing } from "./UnsavedFileDialog";

export { tabsFor, type PanelContext } from "./panel-tools";
const BrowserPanel = lazy(() => import("../panels/BrowserPanel").then((m) => ({ default: m.BrowserPanel })));

function useMountedThroughClose(open: boolean): boolean {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), PANE_MS);
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
  // Only the browser and the new tab, where an address can be typed, carry browser controls.
  if (page.kind !== "newtab") return <PanelContent context={context} page={page} onNavigate={navigate} />;
  const recentUrls = [...new Set(Object.values(previewUrls).filter((url) => /^https?:\/\//i.test(url)))].reverse().slice(0, 4);
  return (
    <div className="h-full flex flex-col min-h-0">
      <PanelNavigation key={`${tab.id}:${tab.index}`} {...navigation} address="" onNavigate={onNavigate} />
      <div className="flex-1 min-h-0">
        <PanelNewTab
          context={context}
          recentUrls={recentUrls}
          onTool={(tool) => {
            if (tool === "file") requestFilesFocus();
            navigate(toolPage(tool));
          }}
          onNavigate={onNavigate}
        />
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
  useFilesHost(panelFileScope(context));
  const windowsControls = useWindowsControls();
  const trafficLights = useTrafficLights();
  const { scope, session, tab } = workspace;
  const closeTab = (id: string) => {
    window.openorc.browser?.close?.(id);
    // A Terminal tab's own shell has no other tab to come back to, so it ends with its tab.
    for (const page of session.tabs.find((entry) => entry.id === id)?.entries ?? []) if (page.kind === "tool" && page.shell) window.openorc.terminal.kill(terminalId(context, page));
    usePanelSessions.getState().close(scope, id);
    requestAnimationFrame(() => {
      const active = usePanelSessions.getState().sessions[scope]?.activeId;
      if (active) document.getElementById(`panel-tab-${active}`)?.focus();
    });
  };
  const closing = useFileTabClosing(session, { close: closeTab, show: (id) => usePanelSessions.getState().select(scope, id) });
  const trafficClearance = !sidebarOpen && trafficLights;
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
          if (expanded && event.key === "Escape" && !event.defaultPrevented) useLayout.getState().setPanelExpanded(false);
        }}
      >
        <div className="panel-pane h-full flex flex-col">
          <PanelHeader scope={scope} session={session} expanded={expanded} trafficClearance={trafficClearance} windowsControls={windowsControls} onClose={closing.requestClose} />
          <div className="panel-card" data-plane>
            <div
              id="panel-tab-content"
              role="tabpanel"
              aria-labelledby={`panel-tab-${tab.id}`}
              data-file-workspace={workspace.page.kind === "file" || undefined}
              className="panel-content flex-1 min-h-0"
            >
              {mounted ? (
                <Suspense fallback={null}>
                  <PanelBody context={context} workspace={workspace} open={open} />
                </Suspense>
              ) : null}
            </div>
          </div>
        </div>
      </aside>
      {closing.dialog}
    </>
  );
}
