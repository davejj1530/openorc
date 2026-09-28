import { useState } from "react";
import type { Project, Task } from "@openorc/protocol";
import { Download, GitCommitHorizontal, GitPullRequest, Upload } from "../components/icons";
import { Button, Dialog, Field, Input, Textarea } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/query";
import { taskBaseLabel, taskCompareUrl } from "../lib/task-review-availability";
import { TargetBranchField, useTargetBranch } from "./PullRequestTarget";

/** Publication forms and errors are independent of the retained review selection. */
export function ReviewPublication({
  task,
  project,
  hasChanges,
  blockedReason,
  exportBranch,
  onNotice: setNotice,
}: {
  task: Task;
  project: Project;
  hasChanges: boolean;
  blockedReason: string | null;
  exportBranch?: string | null;
  onNotice: (message: string) => void;
}) {
  const info = useRpc("system.info", {});
  const commit = useRpcMutation("review.commit");
  const push = useRpcMutation("review.push");
  const exportPatch = useRpcMutation("review.exportPatch");
  const [commitOpen, setCommitOpen] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [message, setMessage] = useState(task.title);
  const ghUrl = taskCompareUrl(project, task);
  return (
    <>
      <Button
        size="sm"
        disabled={Boolean(blockedReason) || !hasChanges || exportPatch.isPending}
        title={blockedReason ?? "Write a lossless patch of these changes to a file"}
        onClick={() =>
          exportPatch.mutate(
            { taskId: task.id },
            {
              onSuccess: (r) => {
                setNotice(`Exported ${r.files} file${r.files === 1 ? "" : "s"} to ${r.path}`);
                window.openorc.revealFile(r.path);
              },
              onError: (e) => setNotice(e.message),
            },
          )
        }
      >
        <Download size={12} /> {exportPatch.isPending ? "Exporting…" : "Export patch"}
      </Button>
      <Button size="sm" disabled={Boolean(blockedReason) || !hasChanges || commit.isPending} title={blockedReason ?? undefined} onClick={() => setCommitOpen(true)}>
        <GitCommitHorizontal size={12} /> Commit
      </Button>
      <Button
        size="sm"
        disabled={Boolean(blockedReason) || !task.branch || push.isPending}
        title={blockedReason ?? undefined}
        onClick={() => push.mutate({ taskId: task.id }, { onSuccess: (r) => setNotice(`Pushed ${r.branch} to ${r.remote}`), onError: (e) => setNotice(e.message) })}
      >
        <Upload size={12} /> {push.isPending ? "Pushing…" : "Push"}
      </Button>
      {info.data?.gh.installed ? (
        <Button size="sm" disabled={Boolean(blockedReason) || !task.branch} onClick={() => setPrOpen(true)} title={blockedReason ?? "Open a pull request"}>
          <GitPullRequest size={12} /> PR
        </Button>
      ) : null}
      {!info.data?.gh.installed && ghUrl ? (
        <Button size="sm" disabled={Boolean(blockedReason)} onClick={() => window.openorc.openExternal(ghUrl)} title={blockedReason ?? "Compare on GitHub"}>
          <GitPullRequest size={12} /> PR
        </Button>
      ) : null}
      <Dialog open={commitOpen} onOpenChange={setCommitOpen} title="Commit all changes">
        <Field label="Message">
          <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} autoFocus />
        </Field>
        {commit.error ? <div className="text-sm text-bad mb-3">{commit.error.message}</div> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={() => setCommitOpen(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={Boolean(blockedReason) || !message.trim() || commit.isPending}
            onClick={() =>
              commit.mutate(
                { taskId: task.id, message: message.trim() },
                {
                  onSuccess: (r) => {
                    setCommitOpen(false);
                    setNotice(`Committed ${r.sha.slice(0, 7)}`);
                  },
                },
              )
            }
          >
            Commit
          </Button>
        </div>
      </Dialog>

      <TaskPullRequestDialog
        open={prOpen}
        onOpenChange={setPrOpen}
        task={task}
        project={project}
        head={task.branch ?? exportBranch ?? null}
        blockedReason={blockedReason}
        onOpened={(url) => {
          setNotice(url);
          window.openorc.openExternal(url);
        }}
      />
    </>
  );
}

/** Target, title and description for the task's pull request. Your edits survive closing the dialog. */
function TaskPullRequestDialog({
  open,
  onOpenChange,
  task,
  project,
  head,
  blockedReason,
  onOpened,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task;
  project: Project;
  head: string | null;
  blockedReason: string | null;
  onOpened: (url: string) => void;
}) {
  const pr = useRpcMutation("review.createPr");
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.spec ?? "");
  const target = useTargetBranch({ project, started: taskBaseLabel(task, project), head, open });
  const base = target.value;
  const openPr = () => {
    if (!base) return;
    pr.mutate(
      { taskId: task.id, title: title.trim(), body, base },
      {
        onSuccess: (r) => {
          onOpenChange(false);
          onOpened(r.url);
        },
      },
    );
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Open a pull request" width={560}>
      <TargetBranchField target={target} disabled={pr.isPending} />
      <Field label="Title">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <Field label="Description">
        <Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <div className="text-sm text-ink-3 mb-3">Push {head} first if it is not on origin yet.</div>
      {pr.error ? <div className="text-sm text-bad mb-3">{pr.error.message}</div> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" disabled={Boolean(blockedReason) || !title.trim() || !base || pr.isPending} onClick={openPr}>
          Create
        </Button>
      </div>
    </Dialog>
  );
}
