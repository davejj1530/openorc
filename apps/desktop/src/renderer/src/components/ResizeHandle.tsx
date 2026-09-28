import { useEffect, useRef, useState } from "react";
import { applyWidths, limits, useLayout } from "../lib/layout";

/** Pointer movement updates CSS only; commit the persistent width on release. */
export function ResizeHandle({ edge }: { edge: "sidebar" | "panel" }) {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; width: number } | null>(null);
  const width = useLayout((s) => (edge === "sidebar" ? s.sidebarWidth : s.panelWidth));
  const commit = (value: number) => {
    const s = useLayout.getState();
    if (edge === "sidebar") s.setSidebarWidth(value);
    else s.setPanelWidth(value);
  };
  const cleanup = () => {
    start.current = null;
    delete document.body.dataset.resizing;
    setDragging(false);
  };
  useEffect(
    () => () => {
      if (!start.current) return;
      delete document.body.dataset.resizing;
      const s = useLayout.getState();
      applyWidths(s.sidebarWidth, s.panelWidth);
    },
    [],
  );
  const widthAt = (clientX: number): number => {
    const st = start.current!;
    const delta = edge === "sidebar" ? clientX - st.x : st.x - clientX;
    return Math.min(limits[edge].max, Math.max(limits[edge].min, st.width + delta));
  };
  const cancel = () => {
    if (!start.current) return;
    const s = useLayout.getState();
    applyWidths(s.sidebarWidth, s.panelWidth);
    cleanup();
  };
  return (
    <div
      role="separator"
      aria-label={`Resize ${edge}`}
      aria-orientation="vertical"
      aria-valuemin={limits[edge].min}
      aria-valuemax={limits[edge].max}
      aria-valuenow={Math.round(width)}
      aria-valuetext={`${Math.round(width)} pixels`}
      tabIndex={0}
      className="resize-handle no-drag"
      data-edge={edge}
      data-dragging={dragging}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        start.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.dataset.resizing = edge;
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        const s = useLayout.getState();
        const next = widthAt(event.clientX);
        applyWidths(edge === "sidebar" ? next : s.sidebarWidth, edge === "panel" ? next : s.panelWidth);
      }}
      onPointerUp={(event) => {
        if (!start.current) return;
        commit(widthAt(event.clientX));
        cleanup();
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onDoubleClick={() => commit(limits[edge].default)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          cancel();
          return;
        }
        if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
        event.preventDefault();
        const direction = (event.key === "ArrowRight" ? 1 : -1) * (edge === "sidebar" ? 1 : -1);
        let target = width + direction * (event.shiftKey ? 32 : 8);
        if (event.key === "Home") target = limits[edge].min;
        else if (event.key === "End") target = limits[edge].max;
        else if (event.key === "Enter") target = limits[edge].default;
        commit(target);
      }}
      title="Drag or use arrow keys to resize. Double-click or press Enter to reset."
    >
      <span className="resize-grip" aria-hidden="true" />
    </div>
  );
}
