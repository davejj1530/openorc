import { useState } from "react";
import type { Project, TeamActionAvailability, Thread, ThreadSummary } from "@openorc/protocol";
import { GitPullRequest } from "../components/icons";
import { Button, Dialog, Field, Input, Textarea } from "../components/ui";
import { useRpc, type useRpcMutation } from "../lib/query";

function compareUrl(project: Project, thread: Thread): string | null {
  const remote = project.gitRemote;
  if (!remote || !thread.branch || thread.workspaceMode !== "worktree") return null;
  const m = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(remote);
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}/compare/${encodeURIComponent(project.defaultBranch ?? "main")}...${encodeURIComponent(thread.branch)}?expand=1`;
}

/** The thread's pull request once it exists, with its state, opening it on GitHub. */
export function PullRequestLink({ thread }: { thread: ThreadSummary }) {
  const url = thread.prUrl;
  if (!url) return null;
  return (
    <Button size="sm" onClick={() => window.openorc.openExternal(url)} title={url}>
      <GitPullRequest size={12} /> {thread.prState ?? "PR"}
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
  action,
  busy,
  ready,
  onOpened,
}: {
  thread: ThreadSummary;
  project: Project;
  /** Owned by the panel, so its other Git actions wait while this one runs. */
  pr: ReturnType<typeof useRpcMutation<"review.createThreadPr">>;
  action: TeamActionAvailability;
  busy: boolean;
  /** Whether the branch can open a pull request now: its own, and on origin with every commit. */
  ready: boolean;
  onOpened: (url: string) => void;
}) {
  const info = useRpc("system.info", {});
  const [open, setOpen] = useState(false);
  if (thread.prUrl) return <PullRequestLink thread={thread} />;
  if (!ready) return null;
  const disabled = !action.allowed || busy;
  if (!info.data?.gh.installed) {
    const ghUrl = compareUrl(project, thread);
    return ghUrl ? (
      <Button size="sm" disabled={disabled} onClick={() => window.openorc.openExternal(ghUrl)} title={action.reason ?? "Compare on GitHub"}>
        <GitPullRequest size={12} /> PR
      </Button>
    ) : null;
  }
  return (
    <>
      <Button size="sm" disabled={disabled} onClick={() => setOpen(true)} title={action.reason ?? "Open a pull request"}>
        <GitPullRequest size={12} /> PR
      </Button>
      <PullRequestDialog open={open} onOpenChange={setOpen} thread={thread} pr={pr} action={action} busy={busy} onOpened={onOpened} />
    </>
  );
}

/**
 * Title and description for a new pull request. Until you edit them they follow the newest
 * commit and the repository's pull request template; your edits survive closing the dialog.
 */
function PullRequestDialog({
  open,
  onOpenChange,
  thread,
  pr,
  action,
  busy,
  onOpened,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  thread: ThreadSummary;
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
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title="Open a pull request"
      width={560}
    >
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
        <Button
          variant="primary"
          disabled={!action.allowed || !title.trim() || busy}
          onClick={() =>
            pr.mutate(
              { threadId: thread.id, title: title.trim(), body },
              {
                onSuccess: (r) => {
                  onOpenChange(false);
                  onOpened(r.url);
                },
              },
            )
          }
        >
          {pr.isPending ? "Opening…" : "Open PR"}
        </Button>
      </div>
    </Dialog>
  );
}
