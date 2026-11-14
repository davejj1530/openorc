import { useEffect, useState } from "react";
import type { HostedReviewState, ThreadSummary } from "@openorc/protocol";
import { CommitSheet } from "../components/CommitSheet";
import { HostedControlReason } from "../components/HostedControlReason";
import { GitPullRequest, Upload } from "../components/icons";
import { Button, Dialog, Field, Input, Textarea } from "../components/ui";
import type { HostedActionController } from "../lib/hosted-review-action";
import { useLayout } from "../lib/layout";

type ControlProps = { action: HostedActionController; reason: string | null };

export function HostedCommitControl({ threadId, action, reason }: ControlProps & { threadId: string }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState(action.request?.kind === "commit" ? action.request.message : "");
  const requested = useLayout((layout) => layout.workspaceChanges);
  const consume = useLayout((layout) => layout.consumeWorkspaceCommit);
  useEffect(() => {
    if (requested?.kind === "thread" && requested.id === threadId && requested.commit) {
      setOpen(true);
      consume(requested.requestId);
    }
  }, [requested, threadId, consume]);
  const commit = () => {
    if (reason || !message.trim()) return;
    action.start({ kind: "commit", id: crypto.randomUUID(), message: message.trim() });
    setOpen(false);
  };
  return (
    <HostedControlReason label="Commit" reason={reason}>
      <CommitSheet
        open={open}
        onOpenChange={setOpen}
        trigger={
          <Button variant="primary" disabled={Boolean(reason)}>
            Commit
          </Button>
        }
        title="Commit changes"
        message={message}
        onMessageChange={setMessage}
        busy={action.pending}
        committing={action.pending && action.request?.kind === "commit"}
        commitDisabled={Boolean(reason) || !message.trim()}
        onCommit={commit}
        placeholder="What changed and why"
      />
    </HostedControlReason>
  );
}

export function HostedPushControl({ action, reason }: ControlProps) {
  return (
    <HostedControlReason label="Push" reason={reason}>
      <Button
        disabled={Boolean(reason)}
        onClick={() => {
          if (!reason) action.start({ kind: "push", id: crypto.randomUUID() });
        }}
      >
        <Upload size={14} />
        Push
      </Button>
    </HostedControlReason>
  );
}

export function HostedPullRequestControl({ thread, state, action, reason }: ControlProps & { thread: ThreadSummary; state: HostedReviewState | undefined }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(action.request?.kind === "pull_request" ? action.request.title : thread.title);
  const [body, setBody] = useState(action.request?.kind === "pull_request" ? action.request.body : "");
  const url = state?.pullRequest?.url ?? thread.prUrl;
  const submit = () => {
    if (reason || !title.trim()) return;
    action.start({ kind: "pull_request", id: crypto.randomUUID(), title: title.trim(), body });
    setOpen(false);
  };
  return (
    <>
      <HostedControlReason label="Pull request" reason={url ? null : reason}>
        <Button
          disabled={!url && Boolean(reason)}
          onClick={() => {
            if (url) void window.openorc.openExternal(url);
            else if (!reason) setOpen(true);
          }}
        >
          <GitPullRequest size={14} />
          {url ? (state?.pullRequest?.state ?? thread.prState ?? "PR") : "PR"}
        </Button>
      </HostedControlReason>
      <Dialog open={open} onOpenChange={setOpen} title="Open a pull request" width={560}>
        <Field label="Base">
          <Input value={state?.baseBranch ?? thread.baseBranch ?? ""} readOnly />
        </Field>
        <Field label="Title">
          <Input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
        </Field>
        <Field label="Body">
          <Textarea rows={6} value={body} onChange={(event) => setBody(event.target.value)} placeholder="What this changes and how to check it" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" disabled={Boolean(reason) || !title.trim()} onClick={submit}>
            Open PR
          </Button>
        </div>
      </Dialog>
    </>
  );
}
