import { useEffect, useState } from "react";
import Image from "@tiptap/extension-image";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { finishImageImport, IMAGE_ACCEPT, readStagedImage, stageImage } from "../../lib/image-imports";
import { Image as ImageIcon, RotateCcw, Trash2, Upload } from "../icons";
import { ThreadImage } from "../ThreadImages";
import { safeImageSource } from "./document-schema";

function imageViewState(pending: boolean, error: string | undefined): string {
  if (!pending) return "saved";
  if (error) return "error";
  return "saving";
}

function TaskImagePreview({ pending, preview, src, alt, error }: { pending: boolean; preview: string | undefined; src: string; alt: string; error: string | undefined }) {
  if (pending)
    return (
      <div className="task-image-pending">
        {preview ? <img src={preview} alt={alt || "Image saving"} /> : <ImageIcon size={24} />}
        <span role="status">{error ? "Image not saved" : "Saving image…"}</span>
      </div>
    );
  if (/^https?:\/\//i.test(src))
    return (
      <div className="task-remote-image">
        <ImageIcon size={18} />
        <span>{alt || "Linked image"}</span>
        <button type="button" onClick={() => window.openorc.openExternal(src)}>
          Open linked image
        </button>
      </div>
    );
  if (safeImageSource(src)) return <ThreadImage key={src} src={src} alt={alt || "Task image"} />;
  return <p role="alert">This image address isn’t supported. Replace or remove it.</p>;
}

function TaskImageView({ node, editor, getPos, selected, updateAttributes, deleteNode }: NodeViewProps) {
  const src = String(node.attrs.src ?? "");
  const alt = String(node.attrs.alt ?? "");
  const pending = src.startsWith("openorc-pending://");
  const [preview, setPreview] = useState<string>();
  const [error, setError] = useState<string>();
  const [attempt, retry] = useState(0);
  const [editingAlt, setEditingAlt] = useState(false);
  useEffect(() => {
    if (!pending) return;
    let active = true;
    let objectUrl: string | undefined;
    const id = src.slice("openorc-pending://".length);
    setError(undefined);
    void readStagedImage(id)
      .then((record) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(record.file);
        setPreview(objectUrl);
        return finishImageImport(id);
      })
      .then((saved) => {
        if (!active || !saved || editor.isDestroyed) return;
        const pos = getPos();
        if (pos === undefined || editor.state.doc.nodeAt(pos)?.attrs.src !== src) return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...editor.state.doc.nodeAt(pos)!.attrs, src: saved.url }).setMeta("addToHistory", false));
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "Couldn’t save the image. Retry or remove it.");
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, pending, attempt, editor, getPos]);

  const replace = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = IMAGE_ACCEPT;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const id = await stageImage(file);
        if (!editor.isDestroyed && getPos() !== undefined) updateAttributes({ src: `openorc-pending://${id}` });
      } catch (reason) {
        setError(String(reason instanceof Error ? reason.message : reason));
      }
    };
    input.click();
  };
  return (
    <NodeViewWrapper className={`task-image${selected ? " is-selected" : ""}`} data-image-state={imageViewState(pending, error)} contentEditable={false}>
      <TaskImagePreview pending={pending} preview={preview} src={src} alt={alt} error={error} />
      {editor.isEditable ? (
        <div className="task-image-tools" aria-label="Image actions">
          <button type="button" onClick={() => setEditingAlt((v) => !v)} aria-expanded={editingAlt}>
            Alt text
          </button>
          <button type="button" onClick={replace}>
            <Upload size={13} />
            Replace
          </button>
          <button type="button" onClick={deleteNode}>
            <Trash2 size={13} />
            Remove
          </button>
        </div>
      ) : null}
      {editingAlt ? (
        <label className="task-image-alt">
          Alternative text
          <input
            autoFocus
            aria-label="Image alternative text"
            value={alt}
            placeholder="Describe this image"
            onChange={(event) => updateAttributes({ alt: event.target.value })}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter" || event.key === "Escape") {
                event.preventDefault();
                setEditingAlt(false);
                editor.commands.focus();
              }
            }}
          />
        </label>
      ) : null}
      {error ? (
        <div className="task-image-error" role="alert">
          {error}{" "}
          {pending ? (
            <button type="button" onClick={() => retry((v) => v + 1)}>
              <RotateCcw size={13} />
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}

export const TaskImage = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(TaskImageView);
  },
});
