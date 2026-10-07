import { useDeferredValue, useState } from "react";
import type { FileSelection } from "../lib/layout";
import { useRpc } from "../lib/query";
import { FileText, Search } from "../components/icons";
import { Input } from "../components/ui";

export function FilesPanel({ projectId, scope, onOpen }: { projectId: string; scope: FileSelection["scope"]; onOpen: (selection: FileSelection) => void }) {
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search);
  const files = useRpc("files.search", { projectId, scope, query, limit: 50 });
  return (
    <section aria-label="Files" className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
        <Search size={15} className="text-ink-3 shrink-0" />
        <Input autoFocus aria-label="Find a file" placeholder="Find a file…" value={search} onChange={(event) => setSearch(event.target.value)} className="flex-1" />
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-2">
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
          <button key={path} onClick={() => onOpen({ path, scope })} className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-left text-sm hover:bg-surface-2">
            <FileText size={15} className="shrink-0 text-ink-3" />
            <span className="truncate">{path}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
