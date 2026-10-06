import { useEffect, useState } from "react";
import type { ImportableSession } from "@openorc/protocol";
import { Button, Dialog, Field, Select } from "../components/ui";
import { cn } from "../lib/cn";
import { useRpc, useRpcMutation } from "../lib/query";
import { openThread } from "../lib/router";
import { relativeTime } from "../lib/time";

const agentLabel: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

function importEmptyState(projectId: string | undefined, loading: boolean, sessionCount: number) {
  if (!projectId) return <div className="text-base text-ink-3">Import a project first.</div>;
  if (loading) return <div className="text-base text-ink-3">Reading the CLIs' history…</div>;
  if (sessionCount === 0) return <div className="text-base text-ink-3">Neither Claude Code nor Codex has sessions for this project.</div>;
  return null;
}

/** Sessions the CLIs keep for this project, picked into threads. Ones already imported are listed but off. */
export function ImportSessionsDialog({ open, projectId: given, onOpenChange }: { open: boolean; projectId?: string; onOpenChange: (open: boolean) => void }) {
  const projects = useRpc("projects.list", {}, { enabled: open });
  const [chosen, setChosen] = useState<string | null>(null);
  // The rail's project when there is one; otherwise the user picks here.
  const projectId = chosen ?? given ?? projects.data?.[0]?.id;
  const list = useRpc("threads.importable", { projectId: projectId ?? "" }, { enabled: open && Boolean(projectId), staleTime: 0 });
  const doImport = useRpcMutation("threads.import");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (open) {
      setPicked(new Set());
      setChosen(null);
    }
  }, [open]);
  const sessions = list.data ?? [];
  const fresh = sessions.filter((s) => !s.threadId);
  const emptyState = importEmptyState(projectId, list.isLoading, sessions.length);
  const toggle = (s: ImportableSession) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(s.path)) next.delete(s.path);
      else next.add(s.path);
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Import terminal sessions" width={600}>
      {(projects.data?.length ?? 0) > 1 ? (
        <Field label="Project">
          <Select value={projectId ?? ""} onChange={(e) => setChosen(e.target.value)}>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {emptyState ?? (
        <>
          <p className="text-sm text-ink-3 mb-2">Sessions you ran from a terminal in this repository. Each becomes a thread that continues where the terminal left off.</p>
          <div className="max-h-80 overflow-y-auto rounded-md border border-line divide-y divide-line">
            {sessions.map((s) => {
              const done = Boolean(s.threadId);
              return (
                <label key={s.path} className={cn("flex items-center gap-3 px-3 h-10 text-base", done ? "text-ink-4" : "hover:bg-surface-2")}>
                  <input type="checkbox" disabled={done} checked={done || picked.has(s.path)} onChange={() => toggle(s)} />
                  <span className="flex-1 min-w-0 truncate">{s.title}</span>
                  <span className="text-xs text-ink-3">{agentLabel[s.agent] ?? s.agent}</span>
                  <span className="text-xs text-ink-4 tabular">{s.messages} msgs</span>
                  <span className="text-xs text-ink-4 tabular w-16 text-right">{done ? "imported" : relativeTime(s.startedAt)}</span>
                </label>
              );
            })}
          </div>
          {doImport.error ? <div className="text-sm text-bad mt-2">{doImport.error.message}</div> : null}
          <div className="flex items-center gap-2 mt-4">
            <button onClick={() => setPicked(new Set(fresh.map((s) => s.path)))} className="text-sm text-ink-3 hover:text-ink">
              Select all
            </button>
            <span className="flex-1" />
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={picked.size === 0 || doImport.isPending}
              onClick={() => {
                if (!projectId) return;
                doImport.mutate(
                  { projectId, sessions: sessions.filter((s) => picked.has(s.path)).map((s) => ({ agent: s.agent, path: s.path })) },
                  {
                    onSuccess: (threads) => {
                      onOpenChange(false);
                      const first = threads[0];
                      if (threads.length === 1 && first) openThread(first.id);
                    },
                  },
                );
              }}
            >
              {doImport.isPending ? "Importing…" : `Import ${picked.size || ""}`.trim()}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
