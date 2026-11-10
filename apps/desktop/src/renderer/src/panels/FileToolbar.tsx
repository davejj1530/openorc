import { useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { explainable, type ExplanationView } from "@openorc/protocol";
import { ArrowLeft, ArrowRight, Check, ChevronRight, Copy, ExternalLink, Folder, FolderOpen, List, MoreHorizontal, RefreshCw } from "../components/icons";
import type { CodeEditorActions } from "../components/code-editor";
import { Button, IconButton, Segmented, Tooltip } from "../components/ui";
import { menuItem, menuPopup, menuSeparator } from "../components/menu";
import { floatingGround } from "../lib/use-anchor-ground";
import { CoversPreview } from "../lib/browser-preview";
import { hasUnsavedEdits } from "../lib/file-buffer";
import { isAbsoluteFilePath, relativeFilePath, useFileExplorer } from "../lib/file-explorer";
import { filesKey } from "../lib/files-tool";
import type { FileSelection } from "../lib/layout";
import type { FileBuffer } from "../lib/use-file-buffer";
import { useWordWrap } from "../lib/word-wrap";
import { openBinaryFile, revealLabel } from "./BinaryView";

export type FileView = "preview" | "source" | ExplanationView;
type ViewOption = { value: FileView; label: string };
/** The ways a file can be read, and where their switcher lives: Markdown's two on the toolbar, the explanations in the file's menu. */
export type FileViews = { place: "toolbar" | "menu"; options: readonly ViewOption[] };
const markdownViews: FileViews = {
  place: "toolbar",
  options: [
    { value: "preview", label: "Preview" },
    { value: "source", label: "Source" },
  ],
};
const codeViews: FileViews = {
  place: "menu",
  options: [
    { value: "source", label: "Code" },
    { value: "english", label: "Plain English" },
    { value: "walkthrough", label: "Walkthrough" },
    { value: "diagram", label: "Diagram" },
  ],
};

export const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

/** Markdown renders; other text can be explained; neither has another view without text. */
export function fileViews(path: string, text: boolean): FileViews | null {
  if (!text) return null;
  if (isMarkdown(path)) return markdownViews;
  return explainable(path) ? codeViews : null;
}

/** Word wrap applies wherever the file shows as lines of code. */
export const showsCode = (view: FileView) => view === "source" || view === "walkthrough";

interface Props {
  selection: FileSelection;
  buffer: FileBuffer;
  directory: string;
  view: FileView;
  onView: (view: FileView) => void;
  treeVisible: boolean;
  onTree: (show: boolean) => void;
  editorActions?: CodeEditorActions | null;
  navigation?: { canBack: boolean; canForward: boolean; back: () => boolean; forward: () => boolean };
}

/**
 * What the breadcrumb shows: the folder's name, then the file's place in it, and the path Copy path copies. A file
 * outside the folder isn't in the explorer: its own folder and name instead, as text, and its full path to copy.
 */
function fileCrumbs(file: string, directory: string): { root: string; parts: string[]; path: string; outside: boolean } {
  const path = relativeFilePath(file, directory);
  if (!isAbsoluteFilePath(path)) return { root: directory.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace", parts: path.split("/"), path, outside: false };
  const segments = path.split(/[\\/]/).filter(Boolean);
  return { root: segments.at(-2) ?? "/", parts: segments.slice(-1), path: file, outside: true };
}

export function FileToolbar({ selection, buffer, directory, view, onView, treeVisible, onTree, editorActions, navigation }: Props) {
  const { root, parts, path, outside } = fileCrumbs(selection.path, directory);
  const views = fileViews(selection.path, buffer.text !== null);
  const reveal = (folder: string) => {
    useFileExplorer.getState().reveal(filesKey(selection.scope), folder ? `${folder}/_` : "_");
    onTree(true);
  };
  return (
    <header className="file-toolbar">
      <nav aria-label="File path" className="file-breadcrumbs" title={selection.path}>
        <ol>
          <li>{outside ? <span className="file-breadcrumb-folder">{root}</span> : <button onClick={() => reveal("")}>{root}</button>}</li>
          {parts.map((part, index) => (
            <li key={parts.slice(0, index + 1).join("/")}>
              <ChevronRight size={12} />
              {index === parts.length - 1 ? (
                <span aria-current="page">
                  {part}
                  {selection.line ? `:${selection.line}${selection.endLine && selection.endLine !== selection.line ? `–${selection.endLine}` : ""}` : ""}
                </span>
              ) : (
                <button onClick={() => reveal(parts.slice(0, index + 1).join("/"))}>{part}</button>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <div className="file-toolbar-actions">
        {navigation && (navigation.canBack || navigation.canForward) ? (
          <>
            <Tooltip label="Go back">
              <IconButton size="xs" aria-label="Go back in code" disabled={!navigation.canBack} onClick={navigation.back}>
                <ArrowLeft size={15} />
              </IconButton>
            </Tooltip>
            <Tooltip label="Go forward">
              <IconButton size="xs" aria-label="Go forward in code" disabled={!navigation.canForward} onClick={navigation.forward}>
                <ArrowRight size={15} />
              </IconButton>
            </Tooltip>
          </>
        ) : null}
        {buffer.readOnly ? (
          <Tooltip label={buffer.readOnly}>
            <span tabIndex={0} className="text-xs text-ink-3">
              Read-only
            </span>
          </Tooltip>
        ) : null}
        {views?.place === "toolbar" ? <Segmented size="sm" label="File view" value={view} onChange={onView} options={views.options} /> : null}
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
        {editorActions ? (
          <Tooltip label="Outline">
            <IconButton size="xs" aria-label="Outline" onClick={editorActions.outline}>
              <List size={15} />
            </IconButton>
          </Tooltip>
        ) : null}
        <FileMenu path={path} buffer={buffer} editorActions={editorActions} views={views?.place === "menu" ? views.options : null} view={view} onView={onView} />
      </div>
    </header>
  );
}

interface MenuProps {
  path: string;
  buffer: FileBuffer;
  editorActions?: CodeEditorActions | null;
  /** The ways to read the file that this menu switches between, when they live here. */
  views: readonly ViewOption[] | null;
  view: FileView;
  onView: (view: FileView) => void;
}

function FileMenu({ path, buffer, editorActions, views, view, onView }: MenuProps) {
  const [notice, setNotice] = useState("");
  const wordWrap = useWordWrap();
  const source = buffer.text !== null && showsCode(view);
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
              {views ? <ViewChoices views={views} view={view} onView={onView} /> : null}
              {editorActions ? (
                <>
                  <Menu.Item className={menuItem} onClick={editorActions.definition}>
                    Go to definition
                  </Menu.Item>
                  <Menu.Item className={menuItem} onClick={editorActions.references}>
                    Find references
                  </Menu.Item>
                  <Menu.Item className={menuItem} onClick={editorActions.problems}>
                    Problems
                  </Menu.Item>
                  <Menu.Item className={menuItem} disabled={buffer.readOnly !== null} onClick={editorActions.quickFixes}>
                    Quick fixes
                  </Menu.Item>
                  <Menu.Separator className={menuSeparator} />
                </>
              ) : null}
              {buffer.text !== null ? (
                <Menu.Item className={menuItem} disabled={buffer.readOnly !== null} onClick={buffer.format}>
                  Format document
                </Menu.Item>
              ) : null}
              {source ? (
                <Menu.CheckboxItem className={menuItem} checked={wordWrap.wrap} onCheckedChange={wordWrap.setWrap}>
                  <Check size={13} className={wordWrap.wrap ? "text-accent-ink" : "text-transparent"} />
                  Word wrap
                </Menu.CheckboxItem>
              ) : null}
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
              <Menu.Item
                className={menuItem}
                disabled={buffer.read.refreshing}
                onClick={() => {
                  buffer.read.refresh();
                  editorActions?.refresh();
                }}
              >
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

/** How to read the file, at the top of its menu: picking one closes the menu on it. */
function ViewChoices({ views, view, onView }: { views: readonly ViewOption[]; view: FileView; onView: (view: FileView) => void }) {
  return (
    <>
      <Menu.RadioGroup aria-label="File view" value={view} onValueChange={(value: FileView) => onView(value)}>
        {views.map((option) => (
          <Menu.RadioItem key={option.value} value={option.value} className={menuItem} closeOnClick>
            <Check size={13} className={view === option.value ? "text-ink" : "text-transparent"} />
            <span className="flex-1">{option.label}</span>
          </Menu.RadioItem>
        ))}
      </Menu.RadioGroup>
      <Menu.Separator className={menuSeparator} />
    </>
  );
}
