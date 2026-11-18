import { useRef, useState, type DragEvent } from "react";
import type { FileScope } from "@openorc/protocol";
import { draggedFile, fileReferenceText, type DraggedFile } from "../lib/file-drag";
import { filesKey } from "../lib/files-tool";
import type { ComposerInputHandle } from "./ComposerInput";
import { ArrowDown, AtSign } from "./icons";

const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

/** What hovers the composer: files from the system to attach, or a file from the Files tool to mention. */
type Hover = { kind: "files"; count: number } | { kind: "reference"; file: DraggedFile };

/**
 * Files dragged over the composer: from the system to attach, or from the Files tool to mention by path. Entering a
 * child fires dragenter before the parent's dragleave, so a counter (not the last event) says whether the drag is
 * still inside.
 *
 * A path is only taken from the composer's own folder, `scope`, since in another conversation's folder it names
 * another file; and only while the prompt can be written in. `input` is the prompt it goes into.
 */
export function useComposerDrop(onFiles: (files: File[]) => void, scope: FileScope | undefined) {
  const depth = useRef(0);
  const input = useRef<ComposerInputHandle>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const folder = scope ? filesKey(scope) : null;
  const mention = (event: DragEvent, dropping = false) => {
    const file = folder && input.current?.writable ? draggedFile(event.dataTransfer, dropping) : null;
    return file?.scope === folder ? file : null;
  };
  const reset = () => {
    depth.current = 0;
    setHover(null);
  };
  const handlers = {
    onDragEnter: (event: DragEvent) => {
      const file = mention(event);
      if (!file && !carriesFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setHover(file ? { kind: "reference", file } : { kind: "files", count: event.dataTransfer.items.length });
    },
    onDragOver: (event: DragEvent) => {
      const file = mention(event);
      if (!file && !carriesFiles(event)) return;
      event.preventDefault();
      if (file) event.dataTransfer.dropEffect = "copy";
    },
    // Only a drag the composer took in counts, and leaving it never asks again whether it would take it.
    onDragLeave: () => {
      if (depth.current === 0) return;
      depth.current -= 1;
      if (depth.current === 0) setHover(null);
    },
    onDrop: (event: DragEvent) => {
      const file = mention(event, true);
      if (!file && !carriesFiles(event)) return;
      event.preventDefault();
      reset();
      if (file) input.current?.insert(fileReferenceText(file));
      else onFiles(Array.from(event.dataTransfer.files));
    },
  };
  return { hover, handlers, input };
}

function dropLabel(hover: Hover): string {
  if (hover.kind === "reference") {
    const name = hover.file.path.split("/").at(-1) ?? hover.file.path;
    return `Release to mention ${fileReferenceText({ path: name, folder: hover.file.folder })}`;
  }
  if (hover.count > 1) return `Release to attach ${hover.count} files`;
  if (hover.count === 1) return "Release to attach the file";
  return "Release to attach";
}

/** Drawn over the composer while files hover it: a darker step, the inverted mark and what letting go does. */
export function ComposerDropZone({ hover }: { hover: Hover }) {
  return (
    <div className="composer-drop-zone" aria-hidden="true">
      <span className="composer-drop-well">{hover.kind === "reference" ? <AtSign size={16} /> : <ArrowDown size={16} />}</span>
      <span>{dropLabel(hover)}</span>
    </div>
  );
}
