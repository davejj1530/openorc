import { useState } from "react";
import type { Project, TeamActionAvailability, ThreadSummary } from "@openorc/protocol";
import type { PullRequestStep } from "@openorc/client";
import { GitPullRequest } from "../components/icons";
import { Button, Dialog, Field, Input, Textarea } from "../components/ui";
import { useRpc, type useRpcMutation } from "../lib/client";
import { TargetBranchField, useTargetBranch } from "./PullRequestTarget";

/** The thread's pull request once it exists, with its state, opening it on GitHub. */
export function PullRequestLink({ thread }: { thread: ThreadSummary }) {
  const url = thread.prUrl;
  if (!url) return null;
  return (
    <Button onClick={() => window.openorc.openExternal(url)} title={url}>
      <GitPullRequest size={14} /> {thread.prState ?? "PR"}
    </Button>
  );
}

/**
 * The thread's pull request: the existing one, or, once the branch is ready, a new one through
 * the GitHub CLI, falling back to GitHub's compare page.
 */
export function ThreadPullRequest({
  thread,
  project,
  pr,
  step,
  busy,
  onOpened,
}: {
  thread: ThreadSummary;
  project: Project;
  /** Owned by the panel, so its other Git actions wait while this one runs. */
  pr: ReturnType<typeof useRpcMutation<"review.createThreadPr">>;
  /** publishView's pull request step: what exists or can be opened now, and why it cannot run. */
  step: PullRequestStep | null;
  busy: boolean;
  onOpened: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!step) return null;
  if (step.kind === "exists") return <PullRequestLink thread={thread} />;
  const { reason } = step.step;
  const disabled = Boolean(reason) || busy;
  if (step.kind === "compare") {
    return (
      <Button disabled={disabled} onClick={() => window.openorc.openExternal(step.url)} title={reason ?? "Compare on GitHub"}>
        <GitPullRequest size={14} /> PR
      </Button>
    );
  }
  return (
    <>
      <Button disabled={disabled} onClick={() => setOpen(true)} title={reason ?? "Open a pull request"}>
        <GitPullRequest size={14} /> PR
      </Button>
      <PullRequestDialog open={open} onOpenChange={setOpen} thread={thread} project={project} head={step.head} pr={pr} action={{ allowed: !reason, reason }} busy={busy} onOpened={onOpened} />
    </>
  );
}

/**
 * Target, title and description for a new pull request. Until you edit them they follow where the
 * thread started, its newest commit and the repository's pull request template; your edits survive
 * closing the dialog.
 */
function PullRequestDialog({
  open,
  onOpenChange,
  thread,
  project,
  head,
  pr,
  action,
  busy,
  onOpened,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  thread: ThreadSummary;
  project: Project;
  head: string | null;
  pr: ReturnType<typeof useRpcMutation<"review.createThreadPr">>;
  action: TeamActionAvailability;
  busy: boolean;
  onOpened: (url: string) => void;
}) {
  const log = useRpc("git.threadLog", { threadId: thread.id });
  const template = useRpc("review.threadPrTemplate", { threadId: thread.id });
  const [editedTitle, setTitle] = useState<string | null>(null);
  const [editedBody, setBody] = useState<string | null>(null);
  const title = editedTitle ?? log.data?.[0]?.subject ?? thread.title;
  const body = editedBody ?? template.data?.body ?? "";
  const target = useTargetBranch({ project, started: thread.baseBranch, head, open });
  const base = target.value;
  const openPr = () => {
    if (!base) return;
    pr.mutate(
      { threadId: thread.id, title: title.trim(), body, base },
      {
        onSuccess: (r) => {
          onOpenChange(false);
          onOpened(r.url);
        },
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title="Open a pull request"
      width={560}
    >
      <TargetBranchField target={target} disabled={busy} />
      <Field label="Title">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} autoFocus />
      </Field>
      <Field label="Body">
        <Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} placeholder="What this changes and how to check it" />
      </Field>
      {action.reason ? (
        <p role="status" className="text-sm text-ink-3 mb-3">
          {action.reason}
        </p>
      ) : null}
      {pr.error ? (
        <div role="alert" className="text-sm text-bad mb-3 break-words">
          {pr.error.message}
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button disabled={busy} onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!action.allowed || !title.trim() || !base || busy} onClick={openPr}>
          {pr.isPending ? "Opening…" : "Open PR"}
        </Button>
      </div>
    </Dialog>
  );
}
