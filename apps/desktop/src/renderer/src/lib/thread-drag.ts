/** Private drag type: text, files, and cross-window payloads cannot open panes. */
export const THREAD_DRAG_TYPE = "application/x-openorc-thread";
let draggedThread: string | null = null;

export function startThreadDrag(transfer: DataTransfer, id: string): void {
  draggedThread = id;
  transfer.effectAllowed = "copy";
  transfer.setData(THREAD_DRAG_TYPE, id);
}

export function endThreadDrag(): void {
  draggedThread = null;
}

export function threadDragId(transfer: DataTransfer, dropping = false): string | null {
  if (!draggedThread || !transfer.types.includes(THREAD_DRAG_TYPE)) return null;
  return !dropping || transfer.getData(THREAD_DRAG_TYPE) === draggedThread ? draggedThread : null;
}
