import type { ThreadActivity } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { orclingById, useOrclings } from "../lib/orclings";
import { useRpc } from "../lib/client";
import { openThread } from "../lib/router";
import { ArrowUpRight, Folder } from "./icons";
import { OrclingAvatar } from "./OrclingAvatar";
import { TextButton } from "./ui";

const activityLabel: Record<ThreadActivity, string> = { running: "Working", waiting: "Needs you", idle: "Idle" };

/** A thread an agent started in a project, shown in the conversation that asked for it: who works there, where, and one click to open it. */
export function StartedThreadCard({ threadId }: { threadId: string }) {
  const thread = useRpc("threads.get", { id: threadId });
  const projects = useRpc("projects.list", {});
  const orcling = orclingById(useOrclings(), thread.data?.orclingId);
  const started = thread.data;
  if (!started) return thread.isLoading ? <div className="surface-card h-14 rounded-2xl" /> : <div className="text-sm text-ink-3">This thread is no longer available.</div>;
  const project = projects.data?.find((candidate) => candidate.id === started.projectId)?.name;
  return (
    <div className="surface-card rounded-2xl px-4 py-3 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        {orcling ? <OrclingAvatar orcling={orcling} size={16} /> : null}
        <button type="button" onClick={() => openThread(started.id)} className="flex-1 min-w-0 text-left text-base text-ink truncate" title={started.title}>
          {started.title}
        </button>
        <TextButton onClick={() => openThread(started.id)} tone="faint" title="Open thread" aria-label={`Open ${started.title}`}>
          <ArrowUpRight size={14} />
        </TextButton>
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-ink-4 min-w-0">
        <span role="status" className={cn("shrink-0", started.activity === "waiting" && "text-warn")}>
          {activityLabel[started.activity]}
        </span>
        {project ? (
          <span className="inline-flex items-center gap-1 min-w-0" title={project}>
            <Folder size={11} className="shrink-0" /> <span className="truncate">{project}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
