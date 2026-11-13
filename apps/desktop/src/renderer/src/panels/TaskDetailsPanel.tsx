import { formatBytes, relativeTime, shortSha } from "@openorc/client";
import { harnessName, type Project, type Task, type TaskPriority, type TaskStatus } from "@openorc/protocol";
import { useState } from "react";
import { Copy, MessageSquare, Play, Trash2 } from "../components/icons";
import { PriorityIcon, priorityLabel, priorityOrder, statusLabel, statusOrder } from "../components/status";
import { Badge, Button, Dialog, Field, IconButton, Input, Select, StatusDot, Textarea, TextButton } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { newThread, openTask, openThread } from "../lib/router";
import "./task-details.css";
import { useTaskFields } from "./useTaskFields";

function taskWorkspaceLabel(mode: Task["workspaceMode"], worktreePath: string | null | undefined): string {
  if (mode !== "worktree") return "Current checkout";
  return worktreePath ? "Isolated worktree" : "Worktree removed";
}

/** Everything about the task that is not the conversation: spec, state, workspace, and the way to end it. */
/** What deleting a task removes, in the confirmation's words. */
function taskDeletionNotice(task: Task, deleteBranch: boolean): string {
  const removes = task.worktreePath ? "The worktree is removed and the task disappears" : "The task disappears";
  const keepsBranch = task.branch && task.workspaceMode === "worktree" && !deleteBranch ? " Uncommitted changes are committed to its branch first, and the branch stays." : "";
  return `${removes} from OpenOrc. The ledger keeps the run history.${keepsBranch}`;
}

export function TaskDetailsPanel({ task: t, project: p }: { task: Task; project: Project }) {
  return <TaskDetails key={t.id} task={t} project={p} />;
}

function TaskDetails({ task: t, project: p }: { task: Task; project: Project }) {
  const fields = useTaskFields(t);
  const cleanup = useRpcMutation("workspace.cleanup");
  const remove = useRpcMutation("tasks.delete");
  const startTask = useRpcMutation("tasks.start");
  const usage = useRpc("workspace.usage", { taskId: t.id }, { enabled: Boolean(t.worktreePath), staleTime: 60_000 });
  const runs = useRpc("runs.listForTask", { taskId: t.id });
  const thread = useRpc("threads.get", { id: t.threadId ?? "" }, { enabled: Boolean(t.threadId) });
  const blockedReason = t.retiredTeam ? "This item is no longer available." : null;
  const [deleting, setDeleting] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const impact = useRpc("workspace.removalImpact", { taskId: t.id }, { enabled: deleting && deleteBranch, staleTime: 0 });
  const loses = Boolean(impact.data && (impact.data.uncommitted > 0 || impact.data.commits > 0));
  const latestRun = (runs.data ?? []).at(-1);
  const tokens = latestRun?.usage ? latestRun.usage.inputTokens + latestRun.usage.outputTokens : 0;

  return (
    <div className="h-full overflow-y-auto p-5 grid grid-cols-1 gap-6 content-start">
      {blockedReason ? (
        <p role="status" className="text-sm text-ink-3">
          {blockedReason}
        </p>
      ) : null}

      {t.status === "proposed" && !t.retiredTeam ? (
        <div className="grid gap-3 rounded-2xl bg-surface-2 px-4 py-3.5 text-base text-ink-2">
          <p className="flex items-center gap-2">
            <StatusDot tone="attention" />
          </p>
          <div>
            <Button
              size="lg"
              variant="primary"
              disabled={Boolean(blockedReason) || startTask.isPending}
              data-tip={blockedReason ?? undefined}
              onClick={() =>
                startTask.mutate(
                  { taskId: t.id },
                  {
                    onSuccess: (run) => {
                      if (run.threadId) openThread(run.threadId);
                    },
                  },
                )
              }
            >
              <Play size={13} /> Start task
            </Button>
          </div>
          {startTask.error ? <div className="text-sm text-bad">{startTask.error.message}</div> : null}
        </div>
      ) : null}

      {!t.retiredTeam ? (
        <div className="grid grid-cols-1 min-w-0 gap-2">
          <Field label="Spec" hint="Attached to every prompt for this task. Say what done looks like.">
            <Textarea variant="sheet" rows={8} value={fields.spec} onChange={(e) => fields.setSpec(e.target.value)} className="font-mono text-sm" />
          </Field>
          <Field label="Labels" hint="Comma separated.">
            <Input variant="sheet" value={fields.labels} onChange={(e) => fields.setLabels(e.target.value)} />
          </Field>
          {fields.dirty ? (
            <div className="flex gap-2">
              <Button variant="primary" disabled={Boolean(t.retiredTeam) || fields.isPending} onClick={fields.save}>
                Save
              </Button>
              <Button variant="ghost" onClick={fields.discard}>
                Discard
              </Button>
            </div>
          ) : null}
          {fields.error ? <div className="text-sm text-bad">{fields.error.message}</div> : null}
        </div>
      ) : null}

      <div className="task-details-rows grid text-base">
        <Row label="Status">
          <Select
            aria-label="Status"
            value={t.status}
            disabled={Boolean(t.retiredTeam) || fields.isPending}
            onChange={(e) => fields.changeStatus(e.target.value as TaskStatus)}
            className="h-7 text-sm w-full"
          >
            {statusOrder.map((s) => (
              <option key={s} value={s}>
                {statusLabel[s]}
              </option>
            ))}
          </Select>
        </Row>
        {fields.error ? (
          <p role="alert" className="text-sm text-bad">
            {fields.error.message}
          </p>
        ) : null}
        <Row label="Priority">
          <div className="flex items-center gap-1.5">
            <PriorityIcon priority={t.priority} />
            <Select value={t.priority} disabled={Boolean(t.retiredTeam) || fields.isPending} onChange={(e) => fields.changePriority(e.target.value as TaskPriority)} className="h-7 text-sm w-full">
              {priorityOrder.map((s) => (
                <option key={s} value={s}>
                  {priorityLabel[s]}
                </option>
              ))}
            </Select>
          </div>
        </Row>
        {t.threadId ? (
          <Row label="Thread">
            {thread.data === null ? (
              <div className="flex items-center gap-2 min-w-0 text-ink-2">
                <span className="truncate">Deleted conversation</span>
                <TextButton onClick={() => openTask(t.id, "chat")} className="shrink-0 text-ink-3 hover:text-ink">
                  Open saved activity
                </TextButton>
              </div>
            ) : (
              <button onClick={() => openThread(t.threadId as string)} className="flex items-center gap-1 text-ink-2 hover:text-ink min-w-0">
                <MessageSquare size={12} className="shrink-0 text-ink-3" />
                <span className="truncate">{thread.data?.title ?? "Open thread"}</span>
              </button>
            )}
          </Row>
        ) : null}
        <Row label="Agent">
          <span className="text-ink-2">{latestRun ? `${harnessName(latestRun.agent)}${latestRun.model ? ` · ${latestRun.model}` : ""}` : "none yet"}</span>
        </Row>
        <Row label="Workspace">
          <span className="text-ink-2">{taskWorkspaceLabel(t.workspaceMode, t.worktreePath)}</span>
        </Row>
        {t.branch ? (
          <Row label="Branch">
            <Mono text={t.branch} />
          </Row>
        ) : null}
        {t.worktreePath ? (
          <Row label="Path">
            <Mono text={t.worktreePath} />
          </Row>
        ) : null}
        {t.baseSha ? (
          <Row label="Base">
            <span className="font-mono text-sm text-ink-2 tabular">
              {t.baseRef ?? ""} {shortSha(t.baseSha)}
            </span>
          </Row>
        ) : null}
        {t.worktreePath ? (
          <Row label="Disk">
            <span className="font-mono text-sm text-ink-2 tabular">{usage.data ? formatBytes(usage.data.bytes) : "…"}</span>
          </Row>
        ) : null}
        <Row label="Usage">
          <span className="font-mono text-sm text-ink-2 tabular">
            {tokens > 0 ? `${tokens.toLocaleString()} tokens` : "–"}
            {t.costUsd > 0 ? ` · $${t.costUsd.toFixed(2)}` : ""}
          </span>
        </Row>
        <Row label="Runs">
          <span className="text-ink-2">{(runs.data ?? []).length}</span>
        </Row>
        {t.labels.length > 0 ? (
          <Row label="Labels">
            <div className="flex flex-wrap gap-1">
              {t.labels.map((l) => (
                <Badge key={l}>{l}</Badge>
              ))}
            </div>
          </Row>
        ) : null}
        <Row label="Created">
          <span className="text-ink-3">{relativeTime(t.createdAt)}</span>
        </Row>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {t.worktreePath ? (
          <Button
            disabled={Boolean(blockedReason) || cleanup.isPending}
            onClick={() => cleanup.mutate({ taskId: t.id })}
            data-tip={blockedReason ?? "Remove the worktree from disk. Uncommitted changes are committed to its branch first; the branch and the history stay."}
          >
            Remove worktree
          </Button>
        ) : null}
        <Button variant="danger" disabled={Boolean(blockedReason)} data-tip={blockedReason ?? undefined} onClick={() => setDeleting(true)}>
          <Trash2 size={13} /> Delete task
        </Button>
        {cleanup.error ? <div className="basis-full text-sm text-bad">{cleanup.error.message}</div> : null}
      </div>

      <Dialog open={deleting} onOpenChange={setDeleting} title="Delete this task?">
        <>
          <p className="text-base text-ink-2 mb-3">{taskDeletionNotice(t, deleteBranch)}</p>
          {t.branch && t.workspaceMode === "worktree" ? (
            <label className="flex items-center gap-2 text-base mb-4">
              <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
              Also delete branch <span className="font-mono text-sm">{t.branch}</span>
            </label>
          ) : null}
          {deleteBranch ? <BranchLossNotice impact={impact} /> : null}
          {remove.error ? <div className="text-sm text-bad mb-3">{remove.error.message}</div> : null}
          <div className="flex justify-end gap-2">
            <Button onClick={() => setDeleting(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={Boolean(blockedReason) || remove.isPending || (deleteBranch && !impact.data)}
              onClick={() =>
                remove.mutate(
                  { id: t.id, deleteBranch, ...(deleteBranch && impact.data ? { acceptLoss: { uncommitted: impact.data.uncommitted, commits: impact.data.commits } } : {}) },
                  {
                    onSuccess: () => {
                      setDeleting(false);
                      if (t.threadId && !(thread.data === null)) openThread(t.threadId);
                      else newThread(p.id);
                    },
                  },
                )
              }
            >
              {deleteBranch && loses ? "Delete task and that work" : "Delete"}
            </Button>
          </div>
        </>
      </Dialog>
    </div>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What deleting the branch would lose, before the user confirms it. */
function BranchLossNotice({ impact }: { impact: ReturnType<typeof useRpc<"workspace.removalImpact">> }) {
  if (impact.isError)
    return (
      <p role="alert" className="text-sm text-bad mb-3">
        Could not check what the branch holds. {impact.error.message}
      </p>
    );
  if (!impact.data)
    return (
      <p role="status" className="text-sm text-ink-3 mb-3">
        Checking what the branch holds…
      </p>
    );
  const { uncommitted, commits } = impact.data;
  if (!uncommitted && !commits) return <p className="text-sm text-ink-3 mb-3">Everything on this branch is also on another branch, a remote, or a tag.</p>;
  const parts = [uncommitted ? `${plural(uncommitted, "uncommitted file")} in its worktree` : null, commits ? `${plural(commits, "commit")} that no other branch, remote or tag has` : null].filter(
    Boolean,
  );
  return (
    <p role="alert" className="text-sm text-bad mb-3">
      Deleting the branch also deletes {parts.join(" and ")}. OpenOrc cannot bring them back.
    </p>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="task-details-row">
      <span>{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Mono({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-1 min-w-0">
      <span className="font-mono text-xs text-ink-2 truncate" data-tip={text}>
        {text}
      </span>
      <IconButton size="xs" aria-label={`Copy ${text}`} onClick={() => void navigator.clipboard.writeText(text)}>
        <Copy size={12} />
      </IconButton>
    </div>
  );
}
