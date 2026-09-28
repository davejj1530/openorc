import { useEffect, useState, type ReactNode } from "react";
import type { Memory, MemorySource, MemoryType } from "@openorc/protocol";
import { MemoryCard } from "../components/MemoryCard";
import { Button, Empty } from "../components/ui";
import { useRpc } from "../lib/query";

const PAGE_SIZE = 25;

interface MemoryFilters {
  projectId: string;
  query: string;
  queryPending: boolean;
  type: MemoryType | "all";
  source: MemorySource | "all";
}

function matchesFilters(memory: Memory, { type, source }: MemoryFilters): boolean {
  return (type === "all" || memory.type === type) && (source === "all" || memory.source === source);
}

function useMemoryPage(filters: MemoryFilters) {
  const { projectId, query, queryPending, type, source } = filters;
  const [page, setPage] = useState(0);
  const searching = query.length > 0;
  // One extra row tells us whether Next is available without counting or loading the collection.
  const list = useRpc(
    "memory.list",
    {
      projectId,
      limit: PAGE_SIZE + 1,
      offset: page * PAGE_SIZE,
      ...(type === "all" ? {} : { types: [type] }),
      ...(source === "all" ? {} : { sources: [source] }),
    },
    { enabled: !searching && !queryPending },
  );
  const found = useRpc("memory.search", { projectId, query: query || "_", limit: 50 }, { enabled: searching && !queryPending });
  const results = searching ? found : list;
  const matches = searching ? (found.data ?? []).filter((m) => matchesFilters(m, filters)) : (list.data ?? []);
  const start = searching ? page * PAGE_SIZE : 0;
  const items = matches.slice(start, start + PAGE_SIZE);
  const hasNext = matches.length > start + PAGE_SIZE;
  const recovering = page > 0 && results.isSuccess && !results.isFetching && items.length === 0;
  useEffect(() => {
    if (recovering) setPage((previous) => Math.max(0, previous - 1));
  }, [recovering, page]);
  return { page, setPage, searching, results, items, hasNext, recovering };
}

function emptyMemoryCopy(filtered: boolean, disabled: boolean): string {
  if (filtered) return "Try another search or clear your filters.";
  if (disabled) return "Turn on OpenOrc memory above when you want agents to start saving and using project knowledge.";
  return "Useful knowledge saved by your agents will appear here.";
}

function memoryStatus(input: { error: Error | null; loading: boolean; searching: boolean; retry: () => void }): ReactNode {
  if (input.error)
    return (
      <p role="alert" className="text-bad py-6">
        Could not load memories. <Button onClick={input.retry}>Try again</Button>
      </p>
    );
  if (input.loading)
    return (
      <p role="status" className="text-ink-2 py-6">
        {input.searching ? "Searching memories…" : "Loading memories…"}
      </p>
    );
  return null;
}

function memoryCount(page: number, count: number, hasNext: boolean, searching: boolean): string {
  const label = searching ? "matching" : "saved";
  const plural = count === 1 ? "memory" : "memories";
  if (count === 0 || (page === 0 && !hasNext)) return `${count} ${label} ${plural}`;
  return `${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + count} ${label} ${plural}`;
}

export function MemoryResults(props: MemoryFilters & { disabled: boolean; clear: () => void }) {
  const { page, setPage, searching, results, items, hasNext, recovering } = useMemoryPage(props);
  const filtered = Boolean(props.query || props.type !== "all" || props.source !== "all");
  const pending = props.queryPending || recovering;
  const busy = results.isFetching || pending;
  const status = memoryStatus({
    error: results.error,
    loading: results.isLoading || pending,
    searching: searching || props.queryPending,
    retry: () => void results.refetch(),
  });
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
        {!status && (
          <p className="text-sm text-ink-3" role="status" aria-live="polite">
            {memoryCount(page, items.length, hasNext, searching)}
            {searching && " · Searches active memories"}
          </p>
        )}
        {(page > 0 || hasNext) && (
          <nav aria-label="Memory pagination" className="flex items-center gap-2">
            <Button aria-label="Previous page" disabled={page === 0 || busy} onClick={() => setPage((previous) => previous - 1)}>
              Previous
            </Button>
            <span className="text-sm text-ink-2">Page {page + 1}</span>
            <Button aria-label="Next page" disabled={!hasNext || busy || results.isError} onClick={() => setPage((previous) => previous + 1)}>
              Next
            </Button>
          </nav>
        )}
      </div>
      {status ?? <MemoryEntries items={items} filtered={filtered} disabled={props.disabled} clear={props.clear} />}
    </>
  );
}

function MemoryEntries({ items, filtered, disabled, clear }: { items: Memory[]; filtered: boolean; disabled: boolean; clear: () => void }) {
  if (items.length === 0)
    return (
      <Empty title={filtered ? "No matching memories" : "No saved memories yet"} action={filtered ? <Button onClick={clear}>Clear filters</Button> : undefined}>
        {emptyMemoryCopy(filtered, disabled)}
      </Empty>
    );
  return (
    <div>
      {items.map((m) => (
        <MemoryCard key={m.id} memory={m} />
      ))}
    </div>
  );
}
