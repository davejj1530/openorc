import { useCallback, useEffect, useMemo } from "react";
import { panelFileScope, panelScope, type PanelContext } from "../components/panel-tools";
import { useBrowserPreview } from "./browser-preview";
import { useLayout, type ChangeSelection, type FileSelection, type PanelTab } from "./layout";
import { activeTab, currentPage, newPanelSession, pageType, usePanelSessions, type PanelPage } from "./panel-tabs";

export function toolPage(tool: PanelTab): PanelPage {
  if (tool === "newtab" || tool === "browser") return { kind: "newtab" };
  if (tool === "file" || tool === "changes") return { kind: tool, selection: null };
  return { kind: "tool", tool };
}

function scopedChanges(context: PanelContext, changes: ChangeSelection | null): ChangeSelection | null {
  if (!changes) return null;
  if (changes.kind === "thread") return context.kind === "thread" && context.thread.id === changes.id ? changes : null;
  if (context.kind === "task") return changes.taskId === context.task.id ? changes : null;
  return context.kind === "thread" && !changes.taskId && changes.threadId === context.thread.id ? changes : null;
}

function requestedPage(context: PanelContext, tab: PanelTab, file: FileSelection | null, changes: ChangeSelection | null): PanelPage {
  if (tab === "browser") return { kind: "browser", url: useLayout.getState().previewUrls[panelScope(context)] ?? "", title: "" };
  const scope = panelFileScope(context);
  if (tab === "file" && file && scope.kind === file.scope.kind && scope.id === file.scope.id) return { kind: "file", selection: file };
  if (tab === "changes") return { kind: "changes", selection: scopedChanges(context, changes) };
  return toolPage(tab);
}

export function usePanelWorkspace(context: PanelContext) {
  const scope = panelScope(context);
  const initial = useMemo(() => newPanelSession(scope), [scope]);
  const session = usePanelSessions((s) => s.sessions[scope]) ?? initial;
  const tab = activeTab(session);
  const page = currentPage(tab);
  const open = useLayout((s) => s.panelOpen);
  const request = useLayout((s) => s.panelRequest);
  useEffect(() => {
    if (!open) return;
    if (request) {
      const layout = useLayout.getState();
      usePanelSessions.getState().open(scope, requestedPage(context, request.tab, layout.selectedFile, layout.selectedChanges));
      useLayout.setState({ panelRequest: null });
    } else useLayout.setState({ panelTab: pageType(page) });
  }, [context, scope, request, open, page]);
  const reveal = useCallback(
    (id: string) => {
      const existing = usePanelSessions.getState().sessions[scope]?.tabs.find((entry) => entry.id === id);
      const old = existing ? currentPage(existing) : null;
      if (old?.kind === "browser") usePanelSessions.getState().select(scope, id);
      else usePanelSessions.getState().open(scope, { kind: "browser", url: "", title: "" }, id);
      useLayout.getState().setPanel(true);
    },
    [scope],
  );
  useBrowserPreview(context.kind === "thread" || context.kind === "task" ? scope : null, reveal);
  const navigate = (next: PanelPage) => {
    if (next.kind === "newtab" && page.kind === "newtab") return;
    if (next.kind === "browser") window.openorc.browser?.navigate?.(tab.id, next.url);
    usePanelSessions.getState().navigate(scope, next);
  };
  return { scope, session, tab, page, navigate };
}
