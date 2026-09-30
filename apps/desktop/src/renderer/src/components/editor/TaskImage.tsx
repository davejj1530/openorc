import { useEffect, useState } from "react";
import Image from "@tiptap/extension-image";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { imageSource, localPath } from "../../../../shared/image-paths";
import { cn } from "../../lib/cn";
import { finishImageImport, IMAGE_ACCEPT, readStagedImage, stageImage } from "../../lib/image-imports";
import { ExternalLink, Image as ImageIcon, Maximize2, Pencil, RotateCcw, Trash2, Upload } from "../icons";
import { useThreadMedia } from "../ThreadImages";
import { IconButton, Tooltip } from "../ui";

const PENDING = "openorc-pending://";

function imageViewState(pending: boolean, error: string | undefined): string {
  if (!pending) return "saved";
  if (error) return "error";
  return "saving";
}

function remoteHost(src: string): string | null {
  if (!/^https?:\/\//i.test(src)) return null;
  try {
    return new URL(src).host;
  } catch {
    return null;
  }
}

/** A staged image while it saves, its saved file, a link to open, or why it cannot be shown. */
function TaskImageContent({ src, alt, preview, error, onView }: { src: string; alt: string; preview: string | undefined; error: string | undefined; onView: (image: string) => void }) {
  const { basePath } = useThreadMedia();
  const [failed, setFailed] = useState(false);
  if (src.startsWith(PENDING))
    return (
      <span className="task-image-frame">
        {preview ? <img src={preview} alt={alt || "Image saving"} draggable={false} /> : <ImageIcon size={24} />}
        <span className="task-image-status" role="status">
          {error ? "Image not saved" : "Saving image…"}
        </span>
      </span>
    );
  // Remote images stay unloaded: fetching one would tell its server the document was opened.
  const host = remoteHost(src);
  if (host)
    return (
      <span className="task-image-card">
        <ImageIcon size={16} />
        <span className="truncate">{alt ? `${alt} · ${host}` : `Image on ${host}`}</span>
      </span>
    );
  const source = imageSource(src, basePath);
  if (!source || failed)
    return (
      <span className="task-image-card" role="img" aria-label={`Image unavailable: ${alt || src}`}>
        <ImageIcon size={16} />
        <span className="truncate">Image unavailable · {alt || src}</span>
      </span>
    );
  return <img src={source} alt={alt} draggable={false} onError={() => setFailed(true)} onDoubleClick={() => onView(source)} />;
}

/** Shows a staged image while it saves, then points its node at the saved file. */
function useStagedImage(src: string, editor: NodeViewProps["editor"], getPos: NodeViewProps["getPos"]) {
  const pending = src.startsWith(PENDING);
  const [preview, setPreview] = useState<string>();
  const [error, setError] = useState<string>();
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (!pending) return;
    let active = true;
    let objectUrl: string | undefined;
    const id = src.slice(PENDING.length);
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
  return { pending, preview, error, setError, retry: () => retry((value) => value + 1) };
}

function TaskImageView({ node, editor, getPos, selected, updateAttributes, deleteNode }: NodeViewProps) {
  const { basePath, openImage } = useThreadMedia();
  const src = String(node.attrs.src ?? "");
  const alt = String(node.attrs.alt ?? "");
  const { pending, preview, error, setError, retry } = useStagedImage(src, editor, getPos);
  const [editingAlt, setEditingAlt] = useState(false);
  const view = (source: string) => openImage({ src: source, label: alt || src.split(/[\\/]/).pop() || "Image", path: localPath(src, basePath) });
  const viewable = imageSource(src, basePath);
  const replace = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = IMAGE_ACCEPT;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const id = await stageImage(file);
        if (!editor.isDestroyed && getPos() !== undefined) updateAttributes({ src: `${PENDING}${id}` });
      } catch (reason) {
        setError(String(reason instanceof Error ? reason.message : reason));
      }
    };
    input.click();
  };
  const tools = [
    ...(viewable ? [{ label: "View image", Icon: Maximize2, run: () => view(viewable) }] : []),
    ...(remoteHost(src) ? [{ label: "Open image link", Icon: ExternalLink, run: () => window.openorc.openExternal(src) }] : []),
    { label: "Edit description", Icon: Pencil, run: () => setEditingAlt((open) => !open) },
    { label: "Replace image", Icon: Upload, run: replace },
    { label: "Remove image", Icon: Trash2, run: deleteNode },
  ];
  return (
    <NodeViewWrapper as="span" className={cn("task-image", selected && "is-selected")} data-image-state={imageViewState(pending, error)} contentEditable={false}>
      <TaskImageContent key={src} src={src} alt={alt} preview={preview} error={error} onView={view} />
      {editor.isEditable ? (
        <span className="task-image-tools" role="toolbar" aria-label="Image actions">
          {tools.map(({ label, Icon, run }) => (
            <Tooltip key={label} label={label}>
              <IconButton size="sm" aria-label={label} onMouseDown={(event) => event.preventDefault()} onClick={run}>
                <Icon size={14} />
              </IconButton>
            </Tooltip>
          ))}
        </span>
      ) : null}
      {editingAlt ? (
        <span className="task-image-alt">
          <input
            autoFocus
            aria-label="Image description"
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
        </span>
      ) : null}
      {error ? (
        <span className="task-image-error" role="alert">
          {error}{" "}
          {pending ? (
            <button type="button" onClick={retry}>
              <RotateCcw size={13} />
              Retry
            </button>
          ) : null}
        </span>
      ) : null}
    </NodeViewWrapper>
  );
}

export const TaskImage = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(TaskImageView);
  },
});
