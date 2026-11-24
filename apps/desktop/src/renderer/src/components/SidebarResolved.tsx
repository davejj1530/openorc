import { useState, type DragEvent, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { useRpcMutation } from "../lib/client";
import { threadDragId, useDraggedThread } from "../lib/thread-drag";
import { ChevronRight, CircleCheck } from "./icons";

/**
 * A place in the list a thread can be dropped on: `accepts` says which dragged threads it takes, and where in it, and
 * `over` lights it while one is held over it.
 */
export function useThreadDrop(accepts: (id: string, over: Element) => boolean, onDrop: (id: string) => void) {
  const [over, setOver] = useState(false);
  const holds = (event: DragEvent, dropping = false) => {
    const id = threadDragId(event.dataTransfer, dropping);
    return id && accepts(id, event.target as Element) ? id : null;
  };
  return {
    over,
    props: {
      onDragOver: (event: DragEvent) => {
        if (!holds(event)) return setOver(false);
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

/** Marks a project's Resolved in the list, so the list knows a thread held over it is not held over the list's own rows. */
export const PROJECT_RESOLVED = "project-resolved";

/**
 * A project's Resolved, the last part of its rows: the word and a chevron, folded until the person opens it. Folded, it
 * still holds the open thread when that one is resolved. While a thread it would take is dragged, it stands out as a
 * place to drop it, and lights while one is held over it.
 */
export function ProjectResolved({
  open,
  onToggle,
  accepts,
  children,
}: {
  open: boolean;
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
  return (
    <div className={PROJECT_RESOLVED} data-open={open || undefined} data-inviting={inviting || undefined} data-drop={drop.over || undefined} {...drop.props}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setArriving(!open);
          onToggle();
        }}
        className="resolved-toggle no-drag"
      >
        Resolved
        <span className="resolved-mark" aria-hidden="true">
          <ChevronRight size={12} className="resolved-chevron" />
          <CircleCheck size={14} className="resolved-check" />
        </span>
      </button>
      <div className={cn("resolved-list sidebar-thread-list", arriving && open && "motion-stagger")}>{children}</div>
    </div>
  );
}
