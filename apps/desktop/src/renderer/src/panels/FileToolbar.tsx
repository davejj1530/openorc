import { useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { ChevronRight, Copy, ExternalLink, Folder, FolderOpen, MoreHorizontal, RefreshCw } from "../components/icons";
import { Button, IconButton, Segmented, Tooltip } from "../components/ui";
import { menuItem, menuPopup, menuSeparator } from "../components/menu";
import { floatingGround } from "../lib/use-anchor-ground";
import { CoversPreview } from "../lib/browser-preview";
import { hasUnsavedEdits } from "../lib/file-buffer";
import { relativeFilePath, useFileExplorer } from "../lib/file-explorer";
import { filesKey } from "../lib/files-tool";
import type { FileSelection } from "../lib/layout";
import type { FileBuffer } from "../lib/use-file-buffer";
import { openBinaryFile, revealLabel } from "./BinaryView";

export type FileView = "preview" | "source";
const views: { value: FileView; label: string }[] = [
  { value: "preview", label: "Preview" },
  { value: "source", label: "Source" },
];

interface Props {
  selection: FileSelection;
  buffer: FileBuffer;
  directory: string;
  view: FileView;
  markdown: boolean;
  onView: (view: FileView) => void;
  treeVisible: boolean;
  onTree: (show: boolean) => void;
}

export function FileToolbar({ selection, buffer, directory, view, markdown, onView, treeVisible, onTree }: Props) {
  const path = relativeFilePath(selection.path, directory);
  const parts = path.split("/");
  const root = directory.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace";
  const reveal = (folder: string) => {
    useFileExplorer.getState().reveal(filesKey(selection.scope), folder ? `${folder}/_` : "_");
    onTree(true);
  };
  return (
    <header className="file-toolbar">
      <nav aria-label="File path" className="file-breadcrumbs" title={selection.path}>
        <ol>
          <li>
            <button onClick={() => reveal("")}>{root}</button>
          </li>
          {parts.map((part, index) => (
            <li key={parts.slice(0, index + 1).join("/")}>
              <ChevronRight size={12} />
              {index === parts.length - 1 ? (
                <span aria-current="page">
                  {part}
                  {selection.line ? `:${selection.line}${selection.endLine ? `–${selection.endLine}` : ""}` : ""}
                </span>
              ) : (
                <button onClick={() => reveal(parts.slice(0, index + 1).join("/"))}>{part}</button>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <div className="file-toolbar-actions">
        {buffer.readOnly ? (
          <Tooltip label={buffer.readOnly}>
            <span tabIndex={0} className="text-xs text-ink-3">
              Read-only
            </span>
          </Tooltip>
        ) : null}
        {markdown ? <Segmented size="sm" label="File view" value={view} onChange={onView} options={views} /> : null}
        {hasUnsavedEdits(buffer.view) || buffer.saving ? (
          <Button size="sm" disabled={buffer.saving || buffer.view.kind === "conflict"} onClick={buffer.save}>
            {buffer.saving ? "Saving…" : "Save"}
          </Button>
        ) : null}
        <Tooltip label={treeVisible ? "Hide file explorer" : "Show file explorer"}>
          <IconButton size="xs" aria-label={treeVisible ? "Hide file explorer" : "Show file explorer"} aria-pressed={treeVisible} onClick={() => onTree(!treeVisible)}>
            <Folder size={15} />
          </IconButton>
        </Tooltip>
        <FileMenu path={path} buffer={buffer} />
      </div>
    </header>
  );
}

function FileMenu({ path, buffer }: { path: string; buffer: FileBuffer }) {
  const [notice, setNotice] = useState("");
  const binary = buffer.view.kind === "binary" ? buffer.view.file : null;
  return (
    <>
      <Menu.Root>
        <Menu.Trigger render={<IconButton size="xs" aria-label="File actions" title="File actions" />}>
          <MoreHorizontal size={15} />
        </Menu.Trigger>
        <Menu.Portal>
          <CoversPreview />
          <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
            <Menu.Popup ref={floatingGround} className={menuPopup}>
              {binary ? (
                <>
                  <Menu.Item className={menuItem} onClick={() => void openBinaryFile(binary)}>
                    <ExternalLink size={14} />
                    Open
                  </Menu.Item>
                  <Menu.Item className={menuItem} onClick={() => window.openorc.revealFile(binary.absolutePath)}>
                    <FolderOpen size={14} />
                    {revealLabel(window.openorc.platform)}
                  </Menu.Item>
                  <Menu.Separator className={menuSeparator} />
                </>
              ) : null}
              <Menu.Item className={menuItem} disabled={buffer.read.refreshing} onClick={buffer.read.refresh}>
                <RefreshCw size={14} />
                Refresh
              </Menu.Item>
              <Menu.Item
                className={menuItem}
                onClick={() => {
                  void navigator.clipboard.writeText(path).then(
                    () => setNotice("Path copied."),
                    () => setNotice("Could not copy the path."),
                  );
                }}
              >
                <Copy size={14} />
                Copy path
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {notice ? (
        <span role="status" className="sr-only">
          {notice}
        </span>
      ) : null}
    </>
  );
}
