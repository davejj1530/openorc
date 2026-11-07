import { useSyncExternalStore } from "react";

/** Private drag type: text, files, and cross-window payloads cannot open panes. */
export const THREAD_DRAG_TYPE = "application/x-openorc-thread";
let draggedThread: string | null = null;
let shownThread: string | null = null;
const listeners = new Set<() => void>();

function show(id: string | null): void {
  if (shownThread === id) return;
  shownThread = id;
  listeners.forEach((listener) => listener());
}

export function startThreadDrag(transfer: DataTransfer, id: string): void {
  draggedThread = id;
  // Copy opens it beside; move puts it in or out of Resolved.
  transfer.effectAllowed = "copyMove";
  transfer.setData(THREAD_DRAG_TYPE, id);
  // Chromium drops a drag whose page changes while it starts.
  requestAnimationFrame(() => show(draggedThread));
}

export function endThreadDrag(): void {
  draggedThread = null;
  show(null);
}

// A row a drop removes never hears its drag end; the window does, after the drop's own handlers.
window.addEventListener("dragend", endThreadDrag);
window.addEventListener("drop", () => setTimeout(endThreadDrag));

export function threadDragId(transfer: DataTransfer, dropping = false): string | null {
  if (!draggedThread || !transfer.types.includes(THREAD_DRAG_TYPE)) return null;
  return !dropping || transfer.getData(THREAD_DRAG_TYPE) === draggedThread ? draggedThread : null;
}

/** The thread being dragged, so the places that take it can show themselves before it reaches them. */
export function useDraggedThread(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => shownThread,
  );
}
