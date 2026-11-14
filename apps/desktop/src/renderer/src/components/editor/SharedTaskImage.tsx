import Image from "@tiptap/extension-image";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { cn } from "../../lib/cn";
import { ExternalLink, Image as ImageIcon, Trash2, Upload } from "../icons";
import { IconButton, Tooltip } from "../ui";

/** Shared text can never turn a device image address into local file access or an import. */
function SharedTaskImageView({ node, selected, editor, deleteNode }: NodeViewProps) {
  const src = String(node.attrs.src ?? "");
  const alt = String(node.attrs.alt ?? "");
  let remote: URL | null = null;
  try {
    const url = new URL(src);
    if (["https:", "http:"].includes(url.protocol)) remote = url;
  } catch {
    /* Device addresses stay unavailable. */
  }
  return (
    <NodeViewWrapper as="span" className={cn("task-image", selected && "is-selected")} data-image-state="saved" contentEditable={false}>
      <span className="task-image-card" role="img" aria-label={remote ? alt || "Remote image" : "Image unavailable"}>
        <ImageIcon size={16} />
        <span className="truncate">{remote ? `${alt || "Image"} · ${remote.host}` : "Image unavailable"}</span>
      </span>
      {editor.isEditable ? (
        <span className="task-image-tools" role="toolbar" aria-label="Image actions">
          {remote ? (
            <Tooltip label="Open image link">
              <IconButton size="xs" aria-label="Open image link" onClick={() => window.openorc.openExternal(src)}>
                <ExternalLink size={14} />
              </IconButton>
            </Tooltip>
          ) : null}
          <Tooltip label="Images aren’t available in shared task documents yet.">
            <IconButton size="xs" aria-label="Replace image" disabled>
              <Upload size={14} />
            </IconButton>
          </Tooltip>
          <Tooltip label="Remove image">
            <IconButton size="xs" aria-label="Remove image" onClick={deleteNode}>
              <Trash2 size={14} />
            </IconButton>
          </Tooltip>
        </span>
      ) : null}
    </NodeViewWrapper>
  );
}
export const SharedTaskImage = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(SharedTaskImageView);
  },
});
