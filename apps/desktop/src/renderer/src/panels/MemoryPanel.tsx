import type { PanelContext } from "../components/Panel";
import { MemoryCard } from "../components/MemoryCard";
import { MemoryControl } from "../components/MemoryControl";
import { Empty } from "../components/ui";
import { useRpc } from "../lib/query";
import { relativeTime } from "../lib/time";

/** What the runs here taught the project: summaries per run for a task, the project's live memory for a thread. */
export function MemoryPanel({ context }: { context: PanelContext }) {
  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="px-3 shrink-0">
        <MemoryControl compact />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">{context.kind === "task" ? <TaskMemory taskId={context.task.id} /> : <ProjectMemory projectId={context.project.id} />}</div>
    </div>
  );
}

function TaskMemory({ taskId }: { taskId: string }) {
  const data = useRpc("memory.forTask", { taskId });
  const memories = data.data?.memories ?? [];
  const summaries = data.data?.summaries ?? [];
  if (!data.isLoading && memories.length === 0 && summaries.length === 0) {
    return <Empty title="No saved history yet">Run summaries and memories associated with this task appear here.</Empty>;
  }
  return (
    <div className="h-full overflow-y-auto p-3 grid gap-4 content-start">
      {summaries.length > 0 ? (
        <section className="grid gap-2">
          <h2 className="text-sm font-medium text-ink-2">Run history</h2>
          {summaries.map((s) => (
            <div key={s.runId} className="surface-card rounded-lg border border-line bg-surface px-3 py-2">
              <div className="flex items-center gap-2 text-sm text-ink-3 mb-1">
                <span className="text-ink-2 font-medium">{s.outcome}</span>
                {s.model ? <span className="font-mono text-xs">{s.model}</span> : null}
                <span className="flex-1" />
                <span className="tabular">{relativeTime(s.createdAt)}</span>
              </div>
              <div className="text-base text-ink-2">{s.workDone}</div>
              {s.openItems.length > 0 ? <div className="mt-1 text-sm text-warn">Open: {s.openItems.join("; ")}</div> : null}
            </div>
          ))}
        </section>
      ) : null}
      {memories.length > 0 ? (
        <section className="grid gap-2">
          <h2 className="text-sm font-medium text-ink-2">Memory from this task</h2>
          {memories.map((m) => (
            <MemoryCard key={m.id} memory={m} />
          ))}
        </section>
      ) : null}
    </div>
  );
}

function ProjectMemory({ projectId }: { projectId: string }) {
  const list = useRpc("memory.list", { projectId, limit: 40 });
  const items = list.data ?? [];
  if (!list.isLoading && items.length === 0) {
    return <Empty title="No saved memories yet">Useful knowledge saved for this project appears here.</Empty>;
  }
  return (
    <div className="h-full overflow-y-auto p-3 grid gap-2 content-start">
      {items.map((m) => (
        <MemoryCard key={m.id} memory={m} />
      ))}
    </div>
  );
}
