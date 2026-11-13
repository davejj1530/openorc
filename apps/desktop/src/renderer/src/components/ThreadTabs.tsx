import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Menu } from "@base-ui/react/menu";
import { threadStatus } from "@openorc/client";
import { isHarnessId, type ThreadSummary } from "@openorc/protocol";
import { useRpc } from "../lib/client";
import { focusedProject, useLayout } from "../lib/layout";
import { useThreadTabs, type ThreadTab } from "../lib/thread-tabs";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";
import { TAB_MIN, tabsShown } from "../lib/tab-fit";
import { useStripHandoff } from "../lib/strip-handoff";
import { useTabReorder } from "../lib/use-tab-reorder";
import { orclingById, useOrclingGroups, useOrclings } from "../lib/orclings";
import { HarnessLogo } from "./HarnessLogo";
import { MessageSquare, PenSquare, X } from "./icons";
import { OrclingAvatar } from "./OrclingAvatar";
import { OrclingFaces } from "./OrclingFaces";
import { ThreadStatusIndicator } from "./ThreadStatusIndicator";
import { IconButton, Tooltip } from "./ui";
import { menuItem, menuPopup } from "./menu";

/**
 * A tab's glyph and name: a thread's own state while it has one to show, else the mark of the agent it runs on, which
 * follows the thread when its model moves to another agent; a new thread's pen. A tab whose thread was deleted closes.
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
      <TabGlyph thread={thread} />
      <span className="work-tab-title">{title ?? thread?.title ?? "Thread"}</span>
    </>
  );
}

/**
 * The slot stays empty until the thread is read, so a tab never flashes a stand-in before its mark. An Orcling's
 * conversation carries the Orcling's face and a group chat its members' faces, where another thread shows its agent.
 */
function TabGlyph({ thread }: { thread: ThreadSummary | null | undefined }) {
  const orclings = useOrclings();
  const groups = useOrclingGroups();
  if (!thread) return <span className="work-tab-icon" />;
  if (thread.session && threadStatus(thread)) return <ThreadStatusIndicator thread={thread} className="work-tab-icon" />;
  const orcling = orclingById(orclings, thread.orclingId);
  if (orcling) return <OrclingAvatar orcling={orcling} size={16} className="work-tab-icon work-tab-orcling" />;
  const group = groups.find((each) => each.threadId === thread.id);
  if (group) return <OrclingFaces members={orclings.filter((each) => group.memberIds.includes(each.id))} size={14} max={2} className="work-tab-icon work-tab-orclings" />;
  if (isHarnessId(thread.agent)) return <HarnessLogo id={thread.agent} size={14} className="work-tab-icon" />;
  return <MessageSquare size={14} className="work-tab-icon" />;
}

/*
 * A thread and a new thread are different screens, each drawing the strip in its own header, so switching tabs can
 * draw it anew. What it has shown and how wide each tab was outlive one drawing: a tab arrives once, when it is first
 * shown, and the rest ease from where they were. Tabs restored at launch were never new.
 */
const shown = new Set(useThreadTabs.getState().tabs.map((tab) => tab.id));

/** A tab's margin after it, the strip's padding, and the room the More button takes with the space before it. */
const TAB_SPACE = 4;
const STRIP_PADDING = 4;
const MORE_ROOM = 76;
const HEADING_GAP = 6;

/**
 * How many other open threads fit as tabs, measured from the header's room and the heading's whole name, again whenever
 * the header changes size, a name in it arrives or changes, or the fonts finish loading.
 */
function useTabsShown(row: RefObject<HTMLDivElement | null>, count: number): number {
  const [fitting, setFitting] = useState(count);
  const measure = useCallback(() => {
    const element = row.current;
    if (!element) return;
    // A header that has not been laid out yet, or is hidden, has no room to measure; it shows every tab until it does.
    if (!element.clientWidth) return setFitting(count);
    const heading = element.querySelector<HTMLElement>(".thread-tab-heading");
    const title = heading?.querySelector<HTMLElement>(".work-tab-title");
    const plus = element.querySelector<HTMLElement>(".work-tabs-new");
    const whole = heading && title ? heading.offsetWidth - title.offsetWidth + title.scrollWidth : 0;
    const room = element.clientWidth - (plus?.offsetWidth ?? 0) - STRIP_PADDING;
    setFitting(tabsShown({ room, heading: whole, count, tab: TAB_MIN + TAB_SPACE, more: MORE_ROOM, gap: HEADING_GAP }));
  }, [row, count]);
  useLayoutEffect(measure);
  useEffect(() => {
    const element = row.current;
    if (!element) return;
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resized?.observe(element);
    const names = new MutationObserver(measure);
    names.observe(element, { childList: true, subtree: true, characterData: true });
    void document.fonts?.ready.then(measure);
    return () => {
      resized?.disconnect();
      names.disconnect();
    };
  }, [row, measure]);
  return fitting;
}

/** The open threads past the header's room, as a menu after the tabs: choosing one makes it the heading. */
function MoreTabs({ tabs, onSelect }: { tabs: ThreadTab[]; onSelect: (id: string) => void }) {
  return (
    <Menu.Root>
      <Menu.Trigger className="thread-tabs-more" aria-label={`${tabs.length} more open ${tabs.length === 1 ? "thread" : "threads"}`}>
        {tabs.length} more
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={8} className="z-40">
          <Menu.Popup ref={floatingGround} className={menuPopup}>
            {tabs.map((tab) => (
              <Menu.Item key={tab.id} className={menuItem} onClick={() => onSelect(tab.id)}>
                <TabFace tab={tab} />
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * The work column's heading and its other open threads. The open thread's name leads the header in title ink, as the
 * column's heading rather than a tab among tabs, with its close on hover. The others follow as tabs on the soft fill,
 * in the order they were opened or dragged to. Short of room they shrink, then the last of them move into a More menu,
 * and only once all of them are there does the heading's name give way; + opens a new thread in a tab of its own. Choosing another tab makes it the heading and puts the one it replaces back in its place among them.
 * Arrow keys, Home and End move from the heading through the others, and dragging a tab along the strip reorders them.
 * `title` stands in for the heading's name while it is renamed, and `onRename` starts that from a double-click.
 */
export function ThreadTabs({ title, onRename }: { title?: ReactNode; onRename?: () => void }) {
  const tabs = useThreadTabs((s) => s.tabs);
  const active = useThreadTabs((s) => s.active);
  const leaving = useThreadTabs((s) => s.leaving);
  const { select, open, close, reorder } = useThreadTabs.getState();
  const projectId = useLayout(focusedProject);
  const arriving = new Set(tabs.filter((tab) => !shown.has(tab.id)).map((tab) => tab.id));
  const current = tabs.find((tab) => tab.id === active && !leaving.includes(tab.id));
  const others = tabs.filter((tab) => tab !== current);
  const staying = others.filter((tab) => !leaving.includes(tab.id));
  const row = useRef<HTMLDivElement | null>(null);
  const shownCount = useTabsShown(row, staying.length);
  const folded = staying.slice(shownCount);
  const inStrip = others.filter((tab) => !folded.includes(tab));
  const reachable = [...(current ? [current] : []), ...staying.slice(0, shownCount)];
  const list = useRef<HTMLDivElement | null>(null);
  const strip = useRef<HTMLDivElement | null>(null);
  useStripHandoff(strip, (id) => arriving.has(id));
  useEffect(() => {
    for (const id of arriving) shown.add(id);
  });
  const onPointerDown = useTabReorder(strip, reorder);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const index = reachable.findIndex((tab) => tab.id === id);
    const target = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: reachable.length - 1 }[event.key];
    const next = target === undefined ? undefined : reachable[target];
    if (!next) return;
    event.preventDefault();
    select(next.id);
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"] [role="tab"]`)?.focus());
  };
  const face = (tab: ThreadTab, selected: boolean) =>
    selected && title ? (
      <div role="tab" aria-selected className="work-tab-face">
        <TabFace tab={tab} title={title} />
      </div>
    ) : (
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        className="work-tab-face"
        onClick={() => select(tab.id)}
        onDoubleClick={selected ? onRename : undefined}
        onKeyDown={(event) => onKeyDown(event, tab.id)}
      >
        <TabFace tab={tab} />
      </button>
    );
  const closeButton = (tab: ThreadTab) => (
    <button type="button" className="work-tab-close" aria-label="Close tab" onClick={() => close(tab.id)}>
      <X size={12} />
    </button>
  );
  return (
    <div ref={row} className="work-tabs-row thread-tabs-row no-drag">
      <div ref={list} className="thread-tabs" role="tablist" aria-label="Open threads">
        {current ? (
          <div key={current.id} data-tab={current.id} className="thread-tab-heading">
            {face(current, true)}
            {closeButton(current)}
          </div>
        ) : null}
        {inStrip.length ? (
          <div ref={strip} className="work-tabs" role="presentation" onPointerDown={onPointerDown}>
            {inStrip.map((tab) => {
              const folding = leaving.includes(tab.id);
              return (
                <div key={tab.id} data-tab={tab.id} className="work-tab" data-leaving={folding || undefined} inert={folding}>
                  {face(tab, false)}
                  {closeButton(tab)}
                </div>
              );
            })}
          </div>
        ) : null}
        {folded.length ? <MoreTabs tabs={folded} onSelect={select} /> : null}
      </div>
      <Tooltip label="New thread">
        <IconButton aria-label="New thread" className="work-tabs-new" onClick={() => open(projectId ?? undefined)}>
          <PenSquare size={16} />
        </IconButton>
      </Tooltip>
    </div>
  );
}
