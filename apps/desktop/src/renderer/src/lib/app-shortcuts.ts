import { useEffect } from "react";
import type { RpcParams, ThreadSummary } from "@openorc/protocol";
import { openFilesTool } from "./files-tool";
import { useLayout } from "./layout";
import { core } from "./rpc";
import { newThread, openThread, useRouter } from "./router";
import { useUi } from "./ui";

interface ShortcutContext {
  projectId: string | undefined;
  focusedThreadId: string | null;
  threadOrder: readonly string[];
}

type Shortcut = (context: ShortcutContext) => boolean;

const act =
  (action: (context: ShortcutContext) => void): Shortcut =>
  (context) => {
    action(context);
    return true;
  };

const togglePanel = act(({ focusedThreadId }) => {
  const layout = useLayout.getState();
  if (focusedThreadId) layout.toggleThreadPanel(focusedThreadId);
  else layout.setPanel(!layout.panelOpen);
});

const step = (direction: 1 | -1) =>
  act(({ focusedThreadId, threadOrder }) => {
    const at = focusedThreadId ? threadOrder.indexOf(focusedThreadId) : -1;
    const next = threadOrder[direction === 1 ? Math.min(threadOrder.length - 1, at + 1) : Math.max(0, at - 1)];
    if (next && next !== focusedThreadId) openThread(next);
  });

const numbered =
  (position: number): Shortcut =>
  ({ threadOrder }) => {
    const id = threadOrder[position - 1];
    if (!id) return false;
    openThread(id);
    return true;
  };

const onFocusedThread =
  (patch: (thread: ThreadSummary) => RpcParams<"threads.update">["patch"]): Shortcut =>
  ({ focusedThreadId }) => {
    if (!focusedThreadId) return false;
    void core.call("threads.get", { id: focusedThreadId }).then((thread) => thread && core.call("threads.update", { id: focusedThreadId, patch: patch(thread) }));
    return true;
  };

export const shortcuts: ReadonlyMap<string, Shortcut> = new Map([
  ["n", act(({ projectId }) => newThread(projectId))],
  ["b", act(() => useLayout.getState().toggleSidebar())],
  ["j", togglePanel],
  ["[", act(() => useRouter.getState().back())],
  ["]", act(() => useRouter.getState().forward())],
  ["\\", act(() => useRouter.getState().closeOtherThreadPanes())],
  ["p", ({ focusedThreadId }) => openFilesTool("names", focusedThreadId)],
  ["f", act(() => useUi.getState().setPalette(true, "messages"))],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((position): [string, Shortcut] => [String(position), numbered(position)]),
  ["⇧[", step(-1)],
  ["⇧]", step(1)],
  ["⇧n", act(({ projectId }) => useUi.getState().openNewTask(projectId))],
  ["⇧f", ({ focusedThreadId }) => openFilesTool("contents", focusedThreadId)],
  ["⇧o", act(() => useLayout.getState().toggleOrcMode())],
  ["⇧p", onFocusedThread((thread) => ({ pinned: !thread.pinnedAt }))],
  ["⇧a", onFocusedThread((thread) => ({ archived: !thread.archivedAt }))],
  ["⇧u", onFocusedThread((thread) => ({ seen: thread.unread }))],
]);

function handleShortcut(event: KeyboardEvent, context: ShortcutContext): void {
  if (event.defaultPrevented || !(event.metaKey || event.ctrlKey)) return;
  const shortcut = shortcuts.get(`${event.shiftKey ? "⇧" : ""}${event.key.toLowerCase()}`);
  if (shortcut?.(context)) event.preventDefault();
}

export function useAppShortcuts(projectId: string | undefined): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { route } = useRouter.getState();
      handleShortcut(event, { projectId, focusedThreadId: route.view === "thread" ? route.threadId : null, threadOrder: useUi.getState().threadOrder });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [projectId]);
}
