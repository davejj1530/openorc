import { useEffect, useState, type ReactNode } from "react";
import type { MemorySource, MemoryType } from "@openorc/protocol";
import { memorySourceLabel } from "../components/MemoryCard";
import { memoryTypeLabel, memoryTypeOrder } from "../components/memory";
import { PageFilters, PageSearch } from "../components/PageFilters";
import { TopBar } from "../components/TopBar";
import { Button, Empty, Select, TextButton } from "../components/ui";
import { useLayout } from "../lib/layout";
import { useRpc } from "../lib/query";
import { newThread, useRouter } from "../lib/router";
import { MemoryResults } from "./memory-results";

function MemoryBrowser({ projectId }: { projectId: string }) {
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [type, setType] = useState<MemoryType | "all">("all");
  const [source, setSource] = useState<MemorySource | "all">("all");
  const settings = useRpc("memory.settings.get", {});
  const navigate = useRouter((s) => s.navigate);
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const filtered = Boolean(query || type !== "all" || source !== "all");
  // Only an acknowledged Off is shown; an unknown setting stays quiet rather than claiming Off.
  const off = settings.data?.enabled === false;
  const clear = () => {
    setQuery("");
    setSearchQuery("");
    setType("all");
    setSource("all");
  };
  return (
    <>
      <PageFilters end={<PageSearch label="Search memories" placeholder="Search memories…" value={query} onChange={setQuery} />}>
        <Select aria-label="Memory type" className="page-filter-select" value={type} onChange={(e) => setType(e.target.value as MemoryType | "all")}>
          <option value="all">All types</option>
          {memoryTypeOrder.map((t) => (
            <option key={t} value={t}>
              {memoryTypeLabel[t]}
            </option>
          ))}
        </Select>
        <Select aria-label="Memory source" className="page-filter-select" value={source} onChange={(e) => setSource(e.target.value as MemorySource | "all")}>
          <option value="all">All sources</option>
          {Object.entries(memorySourceLabel).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </Select>
        {filtered && (
          <Button variant="ghost" onClick={clear}>
            Clear filters
          </Button>
        )}
      </PageFilters>
      <div className="memory-list flex-1 min-h-0 overflow-y-auto pb-4">
        {off ? (
          <p className="memory-off-notice" role="status">
            OpenOrc memory is off. Agents won’t save or recall these memories.{" "}
            <TextButton underline onClick={() => navigate({ view: "settings", section: "memory" })}>
              Turn on in Settings
            </TextButton>
          </p>
        ) : null}
        <MemoryResults
          key={JSON.stringify([searchQuery, type, source])}
          projectId={projectId}
          query={searchQuery}
          queryPending={query.trim() !== searchQuery}
          type={type}
          source={source}
          disabled={off}
          clear={clear}
        />
      </div>
    </>
  );
}

/** A project's saved memories. Turning memory on or off lives in Settings. */
export function Memory() {
  const projects = useRpc("projects.list", {});
  const railProject = useLayout((s) => s.projectId);
  const [selection, setSelection] = useState(railProject ?? "");
  const selectedProject = projects.data?.find((p) => p.id === selection) ?? projects.data?.[0];
  const projectId = selectedProject?.id ?? "";
  let status: ReactNode = null;
  if (projects.error)
    status = (
      <p role="alert" className="text-bad px-2">
        Could not load projects. <Button onClick={() => void projects.refetch()}>Try again</Button>
      </p>
    );
  else if (projects.isLoading)
    status = (
      <p role="status" className="text-ink-2 px-2 py-6">
        Loading projects…
      </p>
    );
  else if (!projectId) status = <Empty title="No project yet">Import a project to browse its saved knowledge.</Empty>;
  return (
    <>
      <TopBar
        projectId={projectId || undefined}
        projectName={selectedProject?.name}
        onProjectChange={(id) => {
          if (id && projects.data?.some((p) => p.id === id)) setSelection(id);
          else newThread(id ?? undefined);
        }}
      >
        Memory
      </TopBar>
      <div className="page-column">{status ?? <MemoryBrowser key={projectId} projectId={projectId} />}</div>
    </>
  );
}
