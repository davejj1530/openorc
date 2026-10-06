import { Fragment, useEffect, useRef, useState } from "react";
import { useLayout } from "../lib/layout";
import { useRpc } from "../lib/query";
import { MAX_THREAD_PANES, useRouter } from "../lib/router";
import { core } from "../lib/rpc";
import { threadDragId } from "../lib/thread-drag";
import { ThreadView } from "../views/ThreadView";
import { Panel } from "./Panel";
import { ThreadPaneDivider } from "./ThreadPaneDivider";

function dropPreviewReason(id: string, visibleThreadIds: readonly string[]): string {
  if (visibleThreadIds.includes(id)) return "This thread is already visible";
  if (visibleThreadIds.length >= MAX_THREAD_PANES) return "Three threads are open · close a pane to add another";
  return "Drop to open beside these threads";
}

/** Keyed panes keep drafts, scroll anchors and subscriptions stable across focus changes. */
export function ThreadWorkspace() {
  const ids = useRouter((s) => s.threadIds);
  const route = useRouter((s) => s.route);
  const owner = useLayout((s) => s.panelThreadId);
  const [preview, setPreview] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const [weights, setWeights] = useState<Record<string, number>>({});
  const viewport = useRef<HTMLDivElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const focused = route.view === "thread" ? route.threadId : null;
  useEffect(() => {
    const clear = () => setPreview(null);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);
  useEffect(() => {
    const container = viewport.current;
    const pane = group.current?.querySelector<HTMLElement>(`[data-thread-pane="${CSS.escape(focused ?? "")}"]`);
    if (!container || !pane) return;
    const bounds = container.getBoundingClientRect();
    const rect = pane.getBoundingClientRect();
    if (rect.left < bounds.left) container.scrollLeft -= bounds.left - rect.left;
    else if (rect.right > bounds.right) container.scrollLeft += rect.right - bounds.right;
  }, [focused]);
  // Forget closed panes so reopening one starts at a sensible size.
  useEffect(() => setWeights((old) => Object.fromEntries(ids.map((id) => [id, old[id] ?? 1]))), [ids]);

  return (
    <>
      <div className="thread-workspace">
        <div
          ref={viewport}
          className="thread-pane-viewport"
          onDragOverCapture={(event) => {
            const id = threadDragId(event.dataTransfer);
            if (!id) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = ids.includes(id) || ids.length >= MAX_THREAD_PANES ? "none" : "copy";
            setPreview(dropPreviewReason(id, ids));
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPreview(null);
          }}
          onDropCapture={(event) => {
            const id = threadDragId(event.dataTransfer, true);
            if (!id) return;
            event.preventDefault();
            event.stopPropagation();
            setPreview(null);
            setDropError(null);
            if (ids.includes(id) || ids.length >= MAX_THREAD_PANES) return;
            // The row may have been deleted while dragging. Don't open a phantom pane.
            void core
              .call("threads.get", { id })
              .then((thread) => {
                if (thread && useRouter.getState().threadIds === ids) useRouter.getState().addThreadPane(id);
                else if (!thread) setDropError("This thread is no longer available.");
              })
              .catch(() => setDropError("Could not open this thread. Try dragging it again."));
          }}
        >
          <div ref={group} className="thread-pane-group" style={{ "--thread-pane-count": ids.length } as React.CSSProperties}>
            {ids.map((id, index) => (
              <Fragment key={id}>
                <section className="thread-pane" data-thread-pane={id} data-focused={id === focused} style={{ flexGrow: weights[id] ?? 1 }}>
                  <ThreadView
                    threadId={id}
                    first={index === 0}
                    last={index === ids.length - 1}
                    focused={id === focused}
                    onClose={ids.length > 1 ? () => useRouter.getState().closeThreadPane(id) : undefined}
                  />
                </section>
                {index < ids.length - 1 ? (
                  <ThreadPaneDivider
                    key={`${id}:${ids[index + 1]}`}
                    left={id}
                    right={ids[index + 1]!}
                    group={group}
                    weights={weights}
                    onResize={(left, right) => setWeights((old) => ({ ...old, [id]: left, [ids[index + 1]!]: right }))}
                  />
                ) : null}
              </Fragment>
            ))}
          </div>
        </div>
        {preview ? (
          <div className="thread-drop-preview" role="status">
            <span>{preview}</span>
          </div>
        ) : null}
        {dropError ? (
          <div className="thread-drop-error" role="status" onClick={() => setDropError(null)}>
            {dropError}
          </div>
        ) : null}
      </div>
      {owner && ids.includes(owner) ? <SharedThreadPanel key={owner} threadId={owner} /> : null}
    </>
  );
}

function SharedThreadPanel({ threadId }: { threadId: string }) {
  const thread = useRpc("threads.get", { id: threadId });
  const project = useRpc("projects.get", { id: thread.data?.projectId ?? "" }, { enabled: Boolean(thread.data) });
  return thread.data && project.data ? <Panel context={{ kind: "thread", thread: thread.data, project: project.data }} /> : null;
}
