import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { useRpcMutation } from "../lib/client";
import { threadDragId, useDraggedThread } from "../lib/thread-drag";
import { useScrollEdges } from "../lib/use-scroll-edges";
import { ChevronRight, CircleCheck } from "./icons";

/** As long as the drawer takes to fold, so its rows leave with it. */
const FOLD_MS = 420;

/**
 * A place in the list a thread can be dropped on: `accepts` says which dragged threads it takes, and `over` lights it
 * while one is held over it.
 */
export function useThreadDrop(accepts: (id: string) => boolean, onDrop: (id: string) => void) {
  const [over, setOver] = useState(false);
  const holds = (event: DragEvent, dropping = false) => {
    const id = threadDragId(event.dataTransfer, dropping);
    return id && accepts(id) ? id : null;
  };
  return {
    over,
    props: {
      onDragOver: (event: DragEvent) => {
        if (!holds(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setOver(true);
      },
      onDragLeave: (event: DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (event: DragEvent) => {
        setOver(false);
        const id = holds(event, true);
        if (!id) return;
        event.preventDefault();
        onDrop(id);
      },
    },
  };
}

/** Puts a thread in Resolved, or brings it back. */
export function useResolveThread() {
  const update = useRpcMutation("threads.update");
  return (id: string, resolved: boolean) => update.mutate({ id, patch: { archived: resolved } });
}

/** The rows a folding drawer keeps until it has folded, so they leave with it rather than before it. */
function useFoldingRows(shown: boolean, rows: ReactNode): ReactNode {
  const kept = useRef(rows);
  const [was, setWas] = useState(shown);
  const [folding, setFolding] = useState(false);
  if (was !== shown) {
    setWas(shown);
    setFolding(!shown);
  }
  useEffect(() => {
    if (!folding) return;
    const timer = setTimeout(() => setFolding(false), FOLD_MS);
    return () => clearTimeout(timer);
  }, [folding]);
  if (shown) kept.current = rows;
  if (shown) return rows;
  return folding ? kept.current : null;
}

/** The rows' natural height, so the drawer can grow to it and no further. */
function useRowsHeight() {
  const [height, setHeight] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!node) return;
    observer.current = new ResizeObserver(() => setHeight(node.scrollHeight));
    observer.current.observe(node);
  }, []);
  return { height, measure };
}

/**
 * Resolved, at the foot of the list above the dock: its heading, the word and a chevron with no count, rises over the
 * list to the height of its rows when opened. Folded, it still holds the open thread when that one is resolved. While a
 * thread it would take is dragged, it stands out as a place to drop it, and lights while one is held over it.
 */
export function ResolvedDrawer({
  open,
  holding,
  onToggle,
  accepts,
  children,
}: {
  open: boolean;
  holding: boolean;
  onToggle: () => void;
  /** Whether a dragged thread can be put here. */
  accepts: (id: string) => boolean;
  children: ReactNode;
}) {
  const resolve = useResolveThread();
  const dragged = useDraggedThread();
  const inviting = Boolean(dragged && accepts(dragged));
  const [arriving, setArriving] = useState(false);
  const drop = useThreadDrop(accepts, (id) => resolve(id, true));
  const shows = open || holding;
  const rows = useFoldingRows(shows, children);
  const { height, measure } = useRowsHeight();
  const edges = useScrollEdges();
  return (
    <div
      className="resolved-drawer"
      style={{ "--resolved-rows": `${shows ? height : 0}px` } as CSSProperties}
      data-open={shows || undefined}
      data-inviting={inviting || undefined}
      data-drop={drop.over || undefined}
      {...drop.props}
    >
      <button
        aria-expanded={open}
        onClick={() => {
          setArriving(!open);
          onToggle();
        }}
        className="resolved-toggle no-drag"
      >
        Resolved
        <span className="resolved-mark" aria-hidden="true">
          <ChevronRight size={12} className="resolved-chevron" data-open={open || undefined} />
          <CircleCheck size={14} className="resolved-check" />
        </span>
      </button>
      <div {...edges} className="resolved-body scroll-edges" inert={!shows}>
        <div ref={measure} className={cn("resolved-list sidebar-thread-list", arriving && "motion-stagger")}>
          {rows}
        </div>
      </div>
    </div>
  );
}
