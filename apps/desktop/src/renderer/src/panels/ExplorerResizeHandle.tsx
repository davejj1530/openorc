import { useRef } from "react";
import { clampExplorerWidth, explorerWidth, useFileExplorer } from "../lib/file-explorer";

export function ExplorerResizeHandle() {
  const width = useFileExplorer((state) => state.width);
  const start = useRef<{ x: number; width: number; workspace: HTMLElement } | null>(null);
  const resize = useFileExplorer.getState().setWidth;
  const cancel = () => {
    if (start.current) start.current.workspace.style.setProperty("--file-explorer-width", `${width}px`);
    start.current = null;
  };
  return (
    <div
      role="separator"
      aria-label="Resize file explorer"
      aria-orientation="vertical"
      aria-valuenow={Math.round(width)}
      aria-valuemin={explorerWidth.min}
      aria-valuemax={explorerWidth.max}
      tabIndex={0}
      className="file-explorer-resize"
      aria-description="Drag or use arrow keys to resize. Double-click to reset."
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const sidebar = event.currentTarget.nextElementSibling;
        const workspace = event.currentTarget.parentElement;
        if (!(sidebar instanceof HTMLElement) || !workspace) return;
        event.currentTarget.focus();
        start.current = { x: event.clientX, width: sidebar.getBoundingClientRect().width, workspace };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = start.current;
        if (drag) drag.workspace.style.setProperty("--file-explorer-width", `${clampExplorerWidth(drag.width + drag.x - event.clientX)}px`);
      }}
      onPointerUp={(event) => {
        const drag = start.current;
        if (!drag) return;
        resize(drag.width + drag.x - event.clientX);
        start.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onDoubleClick={() => resize(explorerWidth.default)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancel();
          return;
        }
        if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
        event.preventDefault();
        if (event.key === "Home") resize(explorerWidth.min);
        else if (event.key === "End") resize(explorerWidth.max);
        else if (event.key === "Enter") resize(explorerWidth.default);
        else resize(width + (event.key === "ArrowLeft" ? 16 : -16));
      }}
    />
  );
}
