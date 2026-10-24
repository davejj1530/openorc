import { useDeferredValue, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { FileEntry, FileScope, FolderPath } from "@openorc/protocol";
import { FileGlyph } from "../components/FileGlyph";
import { ChevronRight, Folder, Search } from "../components/icons";
import { Input } from "../components/ui";
import { ROOT_FOLDERS, relativeFilePath, useFileExplorer } from "../lib/file-explorer";
import { filesKey, useFilesFocus } from "../lib/files-tool";
import { useLayout } from "../lib/layout";
import { useRpc } from "../lib/client";
import { FileExplorerToolbar } from "./FileExplorerToolbar";

interface ExplorerProps {
  scope: FileScope;
  directory: string;
  selected?: string;
}

interface TreeState {
  scope: FileScope;
  expanded: string[];
  selected: string;
  showIgnored: boolean;
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
  const entries = listing.data?.entries.filter((entry) => tree.showIgnored || !entry.ignored || tree.selected === entry.path || tree.selected.startsWith(`${entry.path}/`));
  if (entries?.length === 0) return <p className="file-tree-notice">{listing.data?.entries.length ? "No visible files" : "Empty folder"}</p>;
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
      <div className="file-tree-row" title={entry.path} style={{ paddingLeft: 8 + (level - 1) * 14 }}>
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

function FilteredFiles({ scope, query }: { scope: FileScope; query: string }) {
  const deferred = useDeferredValue(query);
  const files = useRpc("files.search", { scope, query: deferred, limit: 50 });
  return (
    <div className="file-tree-results">
      {files.isLoading ? (
        <p role="status" className="file-tree-notice">
          Searching…
        </p>
      ) : null}
      {files.error ? (
        <p role="alert" className="file-tree-notice">
          {files.error.message}
        </p>
      ) : null}
      {files.data?.length === 0 ? <p className="file-tree-notice">No files found.</p> : null}
      {files.data?.map((path) => (
        <button key={path} className="file-tree-result" title={path} onClick={() => useLayout.getState().openFile({ path, scope })}>
          <FileGlyph path={path} size={14} />
          <span className="min-w-0">
            <span className="block truncate">{path.split("/").at(-1)}</span>
            <span className="block truncate text-xs text-ink-3">{path}</span>
          </span>
        </button>
      ))}
      {files.data?.length === 50 ? <p className="file-tree-notice">First 50 matches. Keep typing to narrow the results.</p> : null}
    </div>
  );
}

export function FileExplorer({ scope, directory, selected = "" }: ExplorerProps) {
  const key = filesKey(scope);
  const listing = useRpc("files.list", { scope, path: "" });
  const root = listing.data?.root ?? directory;
  const path = relativeFilePath(selected, root);
  const expanded = useFileExplorer((state) => state.folders[key]) ?? ROOT_FOLDERS;
  const showIgnored = useFileExplorer((state) => state.showIgnored);
  const [focused, focus] = useState("");
  const [filter, setFilter] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useFilesFocus(input, !selected);
  useEffect(() => {
    if (path) useFileExplorer.getState().reveal(key, path);
  }, [key, path]);
  const tree: TreeState = {
    scope,
    expanded,
    selected: path,
    showIgnored,
    focused,
    focus,
    toggle: (folder) => {
      const current = useFileExplorer.getState().folders[key] ?? ROOT_FOLDERS;
      useFileExplorer.getState().setFolders(key, current.includes(folder) ? current.filter((item) => item !== folder) : [...current, folder]);
    },
  };
  return (
    <section aria-label="File explorer" className="file-explorer">
      <FileExplorerToolbar
        scope={scope}
        showIgnored={showIgnored}
        onShowIgnored={(show) => {
          useFileExplorer.getState().setShowIgnored(show);
          focus("");
        }}
      />
      <div className="file-explorer-body">
        <div className="file-explorer-filter">
          <Search size={13} />
          <Input
            ref={input}
            aria-label="Filter files"
            placeholder="Filter files…"
            value={filter}
            maxLength={500}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setFilter("");
            }}
          />
        </div>
        <div className="file-explorer-scroll">
          {filter.trim() ? (
            <FilteredFiles scope={scope} query={filter} />
          ) : (
            <div role="tree" aria-label="Project files" onKeyDown={(event) => treeKey(event, tree)}>
              <div
                role="treeitem"
                aria-label={root.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace"}
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
                <div className="file-tree-row file-tree-root" title={root}>
                  <ChevronRight size={12} className={expanded.includes("") ? "rotate-90" : ""} />
                  <Folder size={14} className="file-tree-folder" />
                  <span className="truncate">{root.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace"}</span>
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
