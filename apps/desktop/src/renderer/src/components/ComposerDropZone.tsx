import { useRef, useState, type DragEvent } from "react";
import { ArrowDown } from "./icons";

const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

/**
 * Files dragged over the composer. Entering a child fires dragenter before the parent's
 * dragleave, so a counter (not the last event) says whether the drag is still inside.
 */
export function useComposerDrop(onFiles: (files: File[]) => void) {
  const depth = useRef(0);
  const [count, setCount] = useState<number | null>(null);
  const reset = () => {
    depth.current = 0;
    setCount(null);
  };
  const handlers = {
    onDragEnter: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setCount(event.dataTransfer.items.length);
    },
    onDragOver: (event: DragEvent) => {
      if (carriesFiles(event)) event.preventDefault();
    },
    onDragLeave: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setCount(null);
    },
    onDrop: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      reset();
      onFiles(Array.from(event.dataTransfer.files));
    },
  };
  return { dragging: count !== null, count: count ?? 0, handlers };
}

function dropLabel(count: number): string {
  if (count > 1) return `Release to attach ${count} files`;
  if (count === 1) return "Release to attach the file";
  return "Release to attach";
}

/** Drawn over the composer while files hover it: a darker step, the inverted arrow and what letting go does. */
export function ComposerDropZone({ count }: { count: number }) {
  return (
    <div className="composer-drop-zone" aria-hidden="true">
      <span className="composer-drop-well">
        <ArrowDown size={16} />
      </span>
      <span>{dropLabel(count)}</span>
    </div>
  );
}
