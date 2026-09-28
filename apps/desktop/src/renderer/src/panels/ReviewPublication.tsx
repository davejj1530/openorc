import { useState } from "react";
import type { Project, Task } from "@openorc/protocol";
import { Download, GitCommitHorizontal, GitPullRequest, Upload } from "../components/icons";
import { Button, Dialog, Field, Input, Textarea } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/query";
import { taskBaseLabel, taskCompareUrl } from "../lib/task-review-availability";

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
  const pr = useRpcMutation("review.createPr");
  const exportPatch = useRpcMutation("review.exportPatch");
  const [commitOpen, setCommitOpen] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [message, setMessage] = useState(task.title);
  const [prTitle, setPrTitle] = useState(task.title);
  const [prBody, setPrBody] = useState(task.spec ?? "");
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

      <Dialog open={prOpen} onOpenChange={setPrOpen} title="Open a pull request" width={560}>
        <Field label="Title">
          <Input value={prTitle} onChange={(e) => setPrTitle(e.target.value)} autoFocus />
        </Field>
        <Field label="Description">
          <Textarea rows={6} value={prBody} onChange={(e) => setPrBody(e.target.value)} />
        </Field>
        <div className="text-sm text-ink-3 mb-3">
          {task.branch ?? exportBranch} into {taskBaseLabel(task, project)}. Push first if the branch is not on origin yet.
        </div>
        {pr.error ? <div className="text-sm text-bad mb-3">{pr.error.message}</div> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={() => setPrOpen(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={Boolean(blockedReason) || !prTitle.trim() || pr.isPending}
            onClick={() =>
              pr.mutate(
                { taskId: task.id, title: prTitle.trim(), body: prBody },
                {
                  onSuccess: (r) => {
                    setPrOpen(false);
                    setNotice(r.url);
                    window.openorc.openExternal(r.url);
                  },
                },
              )
            }
          >
            Create
          </Button>
        </div>
      </Dialog>
    </>
  );
}
