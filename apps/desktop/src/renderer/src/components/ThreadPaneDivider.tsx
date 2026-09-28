import { useEffect, useRef, useState, type RefObject } from "react";

/** Adjacent panes share a fixed total; a resize cannot steal width from a third pane. */
export function resizeThreadPair(left: number, right: number, delta: number, minimum: number): [number, number] {
  const total = left + right;
  const min = Math.min(minimum, total / 2);
  const next = Math.max(min, Math.min(total - min, left + delta));
  return [next, total - next];
}

function keyboardResizeDelta(key: string, shift: boolean): number {
  if (key === "Home") return -Infinity;
  if (key === "End") return Infinity;
  const direction = key === "ArrowRight" ? 1 : -1;
  return direction * (shift ? 32 : 8);
}

export function ThreadPaneDivider({
  left,
  right,
  group,
  weights,
  onResize,
}: {
  left: string;
  right: string;
  group: RefObject<HTMLDivElement | null>;
  weights: Record<string, number>;
  onResize: (left: number, right: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; left: HTMLElement; right: HTMLElement; widths: [number, number]; weights: [number, number]; min: number } | null>(null);
  const measure = () => {
    const l = group.current?.querySelector<HTMLElement>(`[data-thread-pane="${CSS.escape(left)}"]`);
    const r = group.current?.querySelector<HTMLElement>(`[data-thread-pane="${CSS.escape(right)}"]`);
    if (!l || !r || !group.current) return null;
    return {
      x: 0,
      left: l,
      right: r,
      widths: [l.getBoundingClientRect().width, r.getBoundingClientRect().width] as [number, number],
      weights: [weights[left] ?? 1, weights[right] ?? 1] as [number, number],
      min: parseFloat(getComputedStyle(group.current).getPropertyValue("--thread-pane-min")),
    };
  };
  const apply = (delta: number, commit: boolean) => {
    const s = start.current;
    if (!s) return;
    const widths = resizeThreadPair(...s.widths, delta, s.min);
    const totalWeight = s.weights[0] + s.weights[1];
    const next = widths.map((width) => (width / (s.widths[0] + s.widths[1])) * totalWeight);
    s.left.style.flexGrow = String(next[0]);
    s.right.style.flexGrow = String(next[1]);
    if (commit) onResize(next[0]!, next[1]!);
  };
  const cleanup = () => {
    start.current = null;
    delete document.body.dataset.resizing;
    setDragging(false);
  };
  const cancel = () => {
    if (start.current) {
      start.current.left.style.flexGrow = String(start.current.weights[0]);
      start.current.right.style.flexGrow = String(start.current.weights[1]);
      cleanup();
    }
  };
  useEffect(
    () => () => {
      if (start.current) {
        start.current.left.style.flexGrow = String(start.current.weights[0]);
        start.current.right.style.flexGrow = String(start.current.weights[1]);
        delete document.body.dataset.resizing;
      }
    },
    [],
  );
  const reset = () => {
    const total = (weights[left] ?? 1) + (weights[right] ?? 1);
    onResize(total / 2, total / 2);
  };
  return (
    <div
      role="separator"
      aria-label="Resize thread panes"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(((weights[left] ?? 1) / ((weights[left] ?? 1) + (weights[right] ?? 1))) * 100)}
      tabIndex={0}
      className="resize-handle no-drag thread-pane-divider"
      data-edge="thread"
      data-dragging={dragging}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const measured = measure();
        if (!measured) return;
        start.current = { ...measured, x: event.clientX };
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.dataset.resizing = "thread";
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (start.current) apply(event.clientX - start.current.x, false);
      }}
      onPointerUp={(event) => {
        if (start.current) {
          apply(event.clientX - start.current.x, true);
          cleanup();
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onDoubleClick={reset}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          cancel();
          return;
        }
        if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
        event.preventDefault();
        if (event.key === "Enter") {
          reset();
          return;
        }
        start.current = measure();
        apply(keyboardResizeDelta(event.key, event.shiftKey), true);
        cleanup();
      }}
      title="Drag or use arrow keys to resize. Double-click or press Enter to reset."
    >
      <span className="resize-grip" aria-hidden="true" />
    </div>
  );
}
