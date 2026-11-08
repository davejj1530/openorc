import { useCallback, useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { threadStatus } from "@openorc/client";
import { useRpc } from "../lib/client";
import { cn } from "../lib/cn";
import { focusedProject, useLayout } from "../lib/layout";
import { useThreadTabs, type ThreadTab } from "../lib/thread-tabs";
import { useScrollEdges } from "../lib/use-scroll-edges";
import { useStripHandoff } from "../lib/strip-handoff";
import { MessageSquare, PenSquare, Plus, X } from "./icons";
import { ThreadStatusIndicator } from "./ThreadStatusIndicator";
import { IconButton, Tooltip } from "./ui";

/**
 * A tab's glyph and name: a thread's own state while it has one to show, else a speech mark; a new thread's pen. A tab
 * whose thread was deleted closes.
 */
function TabFace({ tab, title }: { tab: ThreadTab; title?: ReactNode }) {
  const threadId = tab.route.view === "thread" ? tab.route.threadId : "";
  const read = useRpc("threads.get", { id: threadId }, { enabled: Boolean(threadId) });
  const gone = Boolean(threadId) && read.isSuccess && read.data === null;
  useEffect(() => {
    if (gone) useThreadTabs.getState().close(tab.id);
  }, [gone, tab.id]);
  if (tab.route.view === "newthread") {
    return (
      <>
        <PenSquare size={14} className="work-tab-icon" />
        <span className="work-tab-title">New thread</span>
      </>
    );
  }
  const thread = read.data;
  return (
    <>
      {thread?.session && threadStatus(thread) ? <ThreadStatusIndicator thread={thread} className="work-tab-icon" /> : <MessageSquare size={14} className="work-tab-icon" />}
      <span className="work-tab-title">{title ?? thread?.title ?? "Thread"}</span>
    </>
  );
}

/*
 * A thread and a new thread are different screens, each drawing the strip in its own header, so switching tabs can
 * draw it anew. What it has shown, how wide each tab was and how far it scrolled outlive one drawing: a tab arrives
 * once, when it is first shown, the rest ease from where they were, and the strip opens where it was. Tabs restored at
 * launch were never new.
 */
const shown = new Set(useThreadTabs.getState().tabs.map((tab) => tab.id));
let scrolled = 0;
let revealed = false;
/**
 * The strip opens where it was scrolled and keeps the current tab in view whenever `current` changes or the bar narrows
 * as the panel opens beside it. It glides there; only the first reveal, as the app opens, is instant.
 */
function useStripScroll(strip: RefObject<HTMLDivElement | null>, current: string): void {
  useLayoutEffect(() => {
    if (strip.current) strip.current.scrollLeft = scrolled;
  }, [strip]);
  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const reveal = () => {
      element
        .querySelector('[aria-selected="true"]')
        ?.closest(".work-tab")
        ?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: revealed ? "smooth" : "instant" });
      revealed = true;
    };
    reveal();
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reveal);
    resized?.observe(element);
    return () => resized?.disconnect();
  }, [strip, current]);
}

/**
 * The work column's tabs in its title bar: each open thread or new thread, the current one raised on the surface, a
 * close on the current one and on any under the pointer, and + for a new thread in a tab of its own. The tabs scroll
 * sideways once they outgrow the bar, keeping the current one in view; arrow keys, Home and End move between them.
 * `title` stands in for the current tab's name while it is renamed, and `onRename` starts that from a double-click.
 */
export function ThreadTabs({ title, onRename }: { title?: ReactNode; onRename?: () => void }) {
  const tabs = useThreadTabs((s) => s.tabs);
  const active = useThreadTabs((s) => s.active);
  const leaving = useThreadTabs((s) => s.leaving);
  const { select, open, close } = useThreadTabs.getState();
  const projectId = useLayout(focusedProject);
  const arriving = new Set(tabs.filter((tab) => !shown.has(tab.id)).map((tab) => tab.id));
  const reachable = tabs.filter((tab) => !leaving.includes(tab.id));
  const strip = useRef<HTMLDivElement | null>(null);
  const { ref: measureEdges, ...edges } = useScrollEdges("x");
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      strip.current = element;
      return measureEdges(element);
    },
    [measureEdges],
  );
  useStripHandoff(strip, (id) => arriving.has(id));
  useEffect(() => {
    for (const id of arriving) shown.add(id);
  });
  useStripScroll(strip, `${active}:${tabs.length}`);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const index = reachable.findIndex((tab) => tab.id === id);
    const target = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: reachable.length - 1 }[event.key];
    const next = target === undefined ? undefined : reachable[target];
    if (!next) return;
    event.preventDefault();
    select(next.id);
    strip.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"] [role="tab"]`)?.focus();
  };
  return (
    <div className="work-tabs-row no-drag">
      <div
        {...edges}
        ref={attach}
        className="work-tabs scroll-edges-x"
        role="tablist"
        aria-label="Open threads"
        onScroll={(event) => {
          scrolled = event.currentTarget.scrollLeft;
          edges.onScroll();
        }}
      >
        {tabs.map((tab) => {
          const current = tab.id === active;
          const folding = leaving.includes(tab.id);
          return (
            <div key={tab.id} data-tab={tab.id} className={cn("work-tab", current && "work-tab-current")} data-leaving={folding || undefined} inert={folding}>
              {current && title ? (
                <div role="tab" aria-selected className="work-tab-face">
                  <TabFace tab={tab} title={title} />
                </div>
              ) : (
                <button
                  type="button"
                  role="tab"
                  aria-selected={current}
                  tabIndex={current ? 0 : -1}
                  className="work-tab-face"
                  onClick={() => select(tab.id)}
                  onDoubleClick={current ? onRename : undefined}
                  onKeyDown={(event) => onKeyDown(event, tab.id)}
                >
                  <TabFace tab={tab} />
                </button>
              )}
              <button type="button" className="work-tab-close" aria-label="Close tab" onClick={() => close(tab.id)}>
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <Tooltip label="New tab">
        <IconButton aria-label="New tab" className="work-tabs-new" onClick={() => open(projectId ?? undefined)}>
          <Plus size={16} />
        </IconButton>
      </Tooltip>
    </div>
  );
}
