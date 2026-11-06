import { useState, type DragEvent, type ReactNode } from "react";
import { useRpcMutation } from "../lib/client";
import { threadDragId } from "../lib/thread-drag";
import { ChevronRight } from "./icons";

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

/**
 * Resolved, at the foot of the list above the dock: folded to its heading, it rises over the list when opened. Folded,
 * it still holds the open thread when that one is resolved. A thread dropped on it is resolved.
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
  const drop = useThreadDrop(accepts, (id) => resolve(id, true));
  return (
    <div className="resolved-drawer" data-open={open || holding || undefined} data-drop={drop.over || undefined} {...drop.props}>
      <button aria-expanded={open} data-folded={!open || undefined} onClick={onToggle} className="sidebar-section-toggle resolved-drawer-toggle no-drag">
        <span>Resolved</span>
        <ChevronRight size={12} className="resolved-drawer-chevron" />
      </button>
      {open || holding ? <div className="resolved-drawer-list sidebar-thread-list">{children}</div> : null}
    </div>
  );
}
