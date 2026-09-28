import { useEffect, useState, type ReactNode } from "react";
import type { MemorySource, MemoryType } from "@openorc/protocol";
import { Search } from "../components/icons";
import { memorySourceLabel } from "../components/MemoryCard";
import { MemoryControl } from "../components/MemoryControl";
import { memoryTypeLabel, memoryTypeOrder } from "../components/memory";
import { TopBar } from "../components/TopBar";
import { Button, Empty, Input, Select } from "../components/ui";
import { useLayout } from "../lib/layout";
import { useRpc } from "../lib/query";
import { newThread } from "../lib/router";
import { MemoryResults } from "./memory-results";

function MemoryBrowser({ projectId }: { projectId: string }) {
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [type, setType] = useState<MemoryType | "all">("all");
  const [source, setSource] = useState<MemorySource | "all">("all");
  const settings = useRpc("memory.settings.get", {});
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const filtered = Boolean(query || type !== "all" || source !== "all");
  const clear = () => {
    setQuery("");
    setSearchQuery("");
    setType("all");
    setSource("all");
  };
  return (
    <>
      <div className="memory-toolbar">
        <div className="memory-search">
          <Search size={14} />
          <Input aria-label="Search memories" placeholder="Search active memories" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Select aria-label="Memory type" value={type} onChange={(e) => setType(e.target.value as MemoryType | "all")}>
          <option value="all">All types</option>
          {memoryTypeOrder.map((t) => (
            <option key={t} value={t}>
              {memoryTypeLabel[t]}
            </option>
          ))}
        </Select>
        <Select aria-label="Memory source" value={source} onChange={(e) => setSource(e.target.value as MemorySource | "all")}>
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
      </div>
      <MemoryResults
        key={JSON.stringify([searchQuery, type, source])}
        projectId={projectId}
        query={searchQuery}
        queryPending={query.trim() !== searchQuery}
        type={type}
        source={source}
        disabled={settings.data?.enabled === false}
        clear={clear}
      />
    </>
  );
}

export function Memory() {
  const projects = useRpc("projects.list", {});
  const railProject = useLayout((s) => s.projectId);
  const [selection, setSelection] = useState(railProject ?? "");
  const selectedProject = projects.data?.find((p) => p.id === selection) ?? projects.data?.[0];
  const projectId = selectedProject?.id ?? "";
  let status: ReactNode = null;
  if (projects.error)
    status = (
      <p role="alert" className="text-bad">
        Could not load projects. <Button onClick={() => void projects.refetch()}>Try again</Button>
      </p>
    );
  else if (projects.isLoading)
    status = (
      <p role="status" className="text-ink-2 py-6">
        Loading projects…
      </p>
    );
  else if (!projectId) status = <Empty title="No project yet">Import a repository to browse its saved knowledge.</Empty>;
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
      <div className="memory-page">
        <div className="memory-content">
          <header className="mb-6">
            <h1 className="text-xl font-semibold">Project memory</h1>
            <p className="text-md text-ink-2 mt-1">Decisions, lessons, and working knowledge shared across your agents.</p>
          </header>
          <MemoryControl />
          <section className="mt-6" aria-label="Saved memories">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Saved memories</h2>
              <Select aria-label="Project" value={projectId} disabled={!projects.data?.length} onChange={(e) => setSelection(e.target.value)} className="max-w-full">
                {!projects.data?.length && <option value="">{projects.isLoading ? "Loading projects…" : "No projects"}</option>}
                {projects.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
            {status ?? <MemoryBrowser key={projectId} projectId={projectId} />}
          </section>
        </div>
      </div>
    </>
  );
}
