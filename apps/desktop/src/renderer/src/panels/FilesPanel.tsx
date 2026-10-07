import { useDeferredValue, useRef, type KeyboardEvent } from "react";
import type { FileScope } from "@openorc/protocol";
import { requestFilesFocus, useFilesFocus, useFilesToolState, type FilesMode } from "../lib/files-tool";
import { useLayout } from "../lib/layout";
import { useRpc } from "../lib/query";
import { useUi } from "../lib/ui";
import { FileText, Plus, Search } from "../components/icons";
import { IconButton, Input, Segmented, Tooltip } from "../components/ui";
import { FindInFiles } from "./FindInFiles";

const modes: { value: FilesMode; label: string }[] = [
  { value: "names", label: "File names" },
  { value: "contents", label: "Contents" },
];

/** Finds a file in the conversation's folder by name. Each one found opens in its own tab. */
function FileNames({ scope, query, onQuery }: { scope: FileScope; query: string; onQuery: (query: string) => void }) {
  const deferred = useDeferredValue(query);
  const files = useRpc("files.search", { scope, query: deferred, limit: 50 });
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useFilesFocus(input);
  const open = (path: string) => useLayout.getState().openFile({ path, scope });
  const hits = () => [...(list.current?.querySelectorAll("button") ?? [])];
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const first = files.data?.[0];
    if (event.key === "Enter" && !event.nativeEvent.isComposing && first) open(first);
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    hits()[0]?.focus();
  };
  const onHitKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = hits();
    const at = buttons.findIndex((button) => button === event.target);
    if (event.key === "ArrowDown") buttons[at + 1]?.focus();
    else if (event.key === "ArrowUp") (buttons[at - 1] ?? input.current)?.focus();
    else return;
    event.preventDefault();
  };
  return (
    <>
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-line">
        <Search size={15} className="text-ink-3 shrink-0" />
        <Input
          ref={input}
          aria-label="Find a file"
          placeholder="Find a file…"
          maxLength={500}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={onSearchKey}
          className="flex-1"
        />
      </div>
      <div ref={list} onKeyDown={onHitKey} className="flex-1 min-h-0 overflow-auto p-2">
        {files.isLoading ? (
          <p role="status" className="p-3 text-ink-3">
            Loading files…
          </p>
        ) : null}
        {files.error ? (
          <p role="alert" className="p-3 text-ink-3">
            {files.error.message}
          </p>
        ) : null}
        {files.data?.length === 0 ? <p className="p-3 text-ink-3">No files found.</p> : null}
        {files.data?.map((path) => (
          <button key={path} onClick={() => open(path)} className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-left text-sm hover:bg-surface-2 focus-visible:bg-surface-2">
            <FileText size={15} className="shrink-0 text-ink-3" />
            <span className="truncate">{path}</span>
          </button>
        ))}
      </div>
    </>
  );
}

/** The Files tool: finds files by name or by what they contain, and starts new ones. */
export function FilesPanel({ scope }: { scope: FileScope }) {
  const [tool, update] = useFilesToolState(scope);
  return (
    <section aria-label="Files" className="h-full flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-2 px-3 pt-2">
        <Segmented
          size="sm"
          label="Find by"
          value={tool.mode}
          onChange={(mode) => {
            update({ mode });
            requestFilesFocus();
          }}
          options={modes}
        />
        <span className="flex-1" />
        <Tooltip label="New file">
          <IconButton size="sm" aria-label="New file" onClick={() => useUi.getState().setNewFile(scope)}>
            <Plus size={14} />
          </IconButton>
        </Tooltip>
      </div>
      {tool.mode === "names" ? (
        <FileNames scope={scope} query={tool.names} onQuery={(names) => update({ names })} />
      ) : (
        <FindInFiles scope={scope} query={tool.contents} onQuery={(contents) => update({ contents })} />
      )}
    </section>
  );
}
