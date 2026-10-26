import { useCallback, useEffect, useMemo } from "react";
import { panelFileScope, panelScope, panelTools, type PanelContext } from "../components/panel-tools";
import { useBrowserPreview } from "./browser-preview";
import { useLayout, type ChangeSelection, type FileSelection, type PanelTab } from "./layout";
import { activeTab, currentPage, newPanelSession, pageType, usePanelSessions, type PanelPage } from "./panel-tabs";
import { core, type DevicePanelPush } from "./rpc";

export function toolPage(tool: PanelTab): PanelPage {
  if (tool === "newtab" || tool === "browser") return { kind: "newtab" };
  if (tool === "file" || tool === "changes") return { kind: tool, selection: null };
  if (tool === "device") return { kind: "device", deviceId: null, name: panelTools.device.label };
  return { kind: "tool", tool };
}

/** An agent's device joins or leaves its conversation's tabs, whether or not that conversation is on screen. */
export function applyDevicePanelPush(push: DevicePanelPush): void {
  const sessions = usePanelSessions.getState();
  if (push.action === "open") sessions.open(push.surface, { kind: "device", deviceId: push.deviceId, name: push.name });
  else sessions.dropDevice(push.surface, push.deviceId);
}
core.onDevicePanel(applyDevicePanelPush);

/** A device an agent opens in the conversation on screen shows the panel too, the way its browser preview does. */
function useDeviceReveal(surface: string | null): void {
  useEffect(() => {
    if (!surface) return;
    return core.onDevicePanel((push) => {
      if (push.action === "open" && push.surface === surface) useLayout.getState().setPanel(true);
    });
  }, [surface]);
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
  const agentSurface = context.kind === "thread" || context.kind === "task" ? scope : null;
  useBrowserPreview(agentSurface, reveal);
  useDeviceReveal(agentSurface);
  const navigate = (next: PanelPage) => {
    if (next.kind === "newtab" && page.kind === "newtab") return;
    if (next.kind === "browser") window.openorc.browser?.navigate?.(tab.id, next.url);
    usePanelSessions.getState().navigate(scope, next);
  };
  return { scope, session, tab, page, navigate };
}
