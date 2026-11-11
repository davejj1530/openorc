import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { FileEntry, FileScope, FolderPath } from "@openorc/protocol";
import { FileGlyph } from "../components/FileGlyph";
import { ChevronRight, Folder, Search } from "../components/icons";
import { Input } from "../components/ui";
import { isAbsoluteFilePath, ROOT_FOLDERS, relativeFilePath, useFileExplorer } from "../lib/file-explorer";
import { EMPTY_SEARCH, filesKey, useFilesFocus, useFilesToolState, type FilesTool } from "../lib/files-tool";
import { useLayout } from "../lib/layout";
import { useRpc } from "../lib/client";
import { FileExplorerToolbar } from "./FileExplorerToolbar";
import { bestResult, FileSearchResults, firstResult } from "./FileSearch";

interface ExplorerProps {
  scope: FileScope;
  directory: string;
  selected?: string;
}

interface TreeState {
  scope: FileScope;
  expanded: string[];
  selected: string;
  focused: string;
  focus: (path: string) => void;
  toggle: (path: string) => void;
}

function treeKey(event: KeyboardEvent, tree: TreeState) {
  if (!(event.target instanceof HTMLElement)) return;
  const row = event.target.closest<HTMLElement>('[role="treeitem"]');
  if (!row) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const index = rows.indexOf(row);
  const path = row.dataset.path ?? "";
  const expanded = row.getAttribute("aria-expanded");
  let target: HTMLElement | undefined;
  switch (event.key) {
    case "ArrowDown":
      target = rows[index + 1];
      break;
    case "ArrowUp":
      target = rows[index - 1];
      break;
    case "Home":
      target = rows[0];
      break;
    case "End":
      target = rows.at(-1);
      break;
    case "ArrowRight":
      if (expanded === "false") tree.toggle(path);
      else if (expanded === "true") target = rows[index + 1];
      break;
    case "ArrowLeft":
      if (expanded === "true") tree.toggle(path);
      else target = rows.find((item) => item.dataset.path === path.split("/").slice(0, -1).join("/"));
      break;
    case "Enter":
    case " ":
      row.click();
      break;
    default:
      return;
  }
  event.preventDefault();
  event.stopPropagation();
  target?.focus();
}

function DirectoryChildren({ path, level, tree }: { path: "" | FolderPath; level: number; tree: TreeState }) {
  const listing = useRpc("files.list", { scope: tree.scope, path });
  if (listing.isLoading)
    return (
      <p role="status" className="file-tree-notice">
        Loading…
      </p>
    );
  if (listing.error)
    return (
      <div role="alert" className="file-tree-notice">
        <span>{listing.error.message}</span>
        <button
          className="underline ml-2"
          onClick={(event) => {
            event.stopPropagation();
            void listing.refetch();
          }}
        >
          Retry
        </button>
      </div>
    );
  const entries = listing.data?.entries;
  if (entries?.length === 0) return <p className="file-tree-notice">Empty folder</p>;
  return entries?.map((entry) => <TreeEntry key={entry.path} entry={entry} level={level} tree={tree} />);
}

function TreeEntry({ entry, level, tree }: { entry: FileEntry; level: number; tree: TreeState }) {
  const row = useRef<HTMLDivElement>(null);
  const selected = entry.path === tree.selected;
  useEffect(() => {
    if (selected) row.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  const folder = entry.kind === "directory";
  const expanded = folder && tree.expanded.includes(entry.path);
  return (
    <div
      ref={row}
      role="treeitem"
      aria-label={entry.name}
      aria-level={level}
      aria-expanded={folder ? expanded : undefined}
      aria-selected={selected}
      data-path={entry.path}
      tabIndex={tree.focused === entry.path ? 0 : -1}
      onFocus={(event) => {
        event.stopPropagation();
        tree.focus(entry.path);
      }}
      onClick={(event) => {
        event.stopPropagation();
        event.currentTarget.focus();
        if (folder) tree.toggle(entry.path);
        else useLayout.getState().openFile({ path: entry.path, scope: tree.scope });
      }}
    >
      <div className={entry.ignored ? "file-tree-row file-tree-ignored" : "file-tree-row"} data-tip={entry.path} style={{ paddingLeft: 8 + (level - 1) * 14 }}>
        {folder ? <ChevronRight size={12} className={expanded ? "rotate-90" : ""} /> : <span className="w-3 shrink-0" />}
        {folder ? <Folder size={14} className="file-tree-folder" /> : <FileGlyph path={entry.path} size={14} />}
        <span className="truncate">{entry.name}</span>
      </div>
      {expanded ? (
        <div role="group" className="file-tree-group">
          <span aria-hidden="true" className="file-tree-guide" style={{ left: 14 + (level - 1) * 14 }} />
          <DirectoryChildren path={entry.path} level={level + 1} tree={tree} />
        </div>
      ) : null}
    </div>
  );
}

/** The Files tool's search is the conversation's, kept between showings and set by ⌘P; the tree beside an open file keeps its own. */
function useExplorerSearch(scope: FileScope, beside: boolean): [FilesTool, (change: Partial<FilesTool>) => void] {
  const shared = useFilesToolState(scope);
  const [own, setOwn] = useState(EMPTY_SEARCH);
  return beside ? [own, (change) => setOwn((current) => ({ ...current, ...change }))] : shared;
}

export function FileExplorer({ scope, directory, selected = "" }: ExplorerProps) {
  const key = filesKey(scope);
  const listing = useRpc("files.list", { scope, path: "" });
  const root = listing.data?.root ?? directory;
  // A file outside the folder has no place in the tree to reveal.
  const inTree = relativeFilePath(selected, root);
  const path = isAbsoluteFilePath(inTree) ? "" : inTree;
  const expanded = useFileExplorer((state) => state.folders[key]) ?? ROOT_FOLDERS;
  const [focused, focus] = useState("");
  const [search, update] = useExplorerSearch(scope, Boolean(selected));
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const rootName = root.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace";
  useFilesFocus(input, !selected);
  useEffect(() => {
    if (path) useFileExplorer.getState().reveal(key, path);
  }, [key, path]);
  const tree: TreeState = {
    scope,
    expanded,
    selected: path,
    focused,
    focus,
    toggle: (folder) => {
      const current = useFileExplorer.getState().folders[key] ?? ROOT_FOLDERS;
      useFileExplorer.getState().setFolders(key, current.includes(folder) ? current.filter((item) => item !== folder) : [...current, folder]);
    },
  };
  return (
    <section aria-label="File explorer" className="file-explorer">
      <FileExplorerToolbar scope={scope} />
      <div className="file-explorer-body">
        <div className="file-explorer-filter">
          <Search size={16} />
          <Input
            ref={input}
            aria-label="Search files"
            placeholder="Search files…"
            value={search.query}
            maxLength={500}
            onChange={(event) => update({ query: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Escape" && search.query) update({ query: "" });
              else if (event.key === "Enter" && !event.nativeEvent.isComposing) bestResult(results.current)?.click();
              else if (event.key === "ArrowDown") firstResult(results.current)?.focus();
              else return;
              event.preventDefault();
            }}
          />
        </div>
        <div className="file-explorer-scroll">
          {search.query.trim() ? (
            <FileSearchResults ref={results} scope={scope} root={rootName} folders={expanded} tool={search} update={update} onBack={() => input.current?.focus()} />
          ) : (
            <div role="tree" aria-label="Project files" onKeyDown={(event) => treeKey(event, tree)}>
              <div
                role="treeitem"
                aria-label={rootName}
                aria-level={1}
                aria-expanded={expanded.includes("")}
                data-path=""
                tabIndex={focused === "" ? 0 : -1}
                onFocus={(event) => {
                  event.stopPropagation();
                  focus("");
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  event.currentTarget.focus();
                  tree.toggle("");
                }}
              >
                <div className="file-tree-row file-tree-root" data-tip={root}>
                  <ChevronRight size={12} className={expanded.includes("") ? "rotate-90" : ""} />
                  <Folder size={14} className="file-tree-folder" />
                  <span className="truncate">{rootName}</span>
                </div>
                {expanded.includes("") ? (
                  <div role="group">
                    <DirectoryChildren path="" level={2} tree={tree} />
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
