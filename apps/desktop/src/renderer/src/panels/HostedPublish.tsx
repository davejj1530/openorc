import type { ReactNode } from "react";
import type { HostedReviewState, HostedThreadChanges, ThreadSummary } from "@openorc/protocol";
import { hostedActionLine, hostedPublishReason } from "@openorc/client";
import { PanelBar, PanelNotice } from "../components/PanelBar";
import { Button } from "../components/ui";
import { useHostedReviewAction, type HostedActionController } from "../lib/hosted-review-action";
import { useRpc } from "../lib/client";
import { HostedCommitControl, HostedPullRequestControl, HostedPushControl } from "./HostedPublishControls";
import { useHostedBring } from "./HostedBring";

type PublishProps = {
  thread: ThreadSummary;
  state?: HostedReviewState;
  changes?: HostedThreadChanges;
  heading: ReactNode;
  meta?: ReactNode;
  refresh?: ReactNode;
  stateError?: Error | null;
  surface?: "changes" | "commits";
};

export function HostedPublish(props: PublishProps) {
  const account = useRpc("account.status", {}).data;
  if (account?.state !== "signed-in")
    return (
      <PanelBar title={props.heading} meta={props.meta}>
        {props.refresh}
      </PanelBar>
    );
  return <HostedPublishForm key={`${account.email}:${props.thread.id}:${props.surface ?? "changes"}`} {...props} account={account.email} />;
}

function commitUnavailable(reason: string | null, changes: HostedThreadChanges | undefined, state: HostedReviewState | undefined): string | null {
  if (reason) return reason;
  if (!changes || changes.state === "missing" || (changes.state === "recorded" && changes.missing)) return "The latest changes weren't recorded.";
  return state?.work.uncommitted ? null : "Nothing to commit.";
}

function HostedPublishForm({ thread, state, changes, heading, meta, refresh, stateError, account, surface = "changes" }: PublishProps & { account: string }) {
  const action = useHostedReviewAction(thread.id, thread.owner?.reach === "live", account);
  // A project from a folder of a Mac has no GitHub to push to: its work comes back to the folder instead.
  const bring = useHostedBring(thread.id);
  const waiting = action.pending ? "Wait for the current action to finish." : null;
  const reason = waiting ?? stateError?.message ?? hostedPublishReason(thread, state);
  const commits = bring.mac ? bring.control : <HostedCommitActions thread={thread} state={state} action={action} reason={reason} />;
  return (
    <>
      <PanelBar title={heading} meta={meta}>
        {surface === "commits" ? (
          commits
        ) : (
          <>
            {state?.pullRequest?.url || thread.prUrl ? <HostedPullRequestControl thread={thread} state={state} action={action} reason={reason} /> : null}
            {refresh}
            <HostedCommitControl threadId={thread.id} action={action} reason={commitUnavailable(reason, changes, state)} />
          </>
        )}
      </PanelBar>
      <HostedPublishNotice action={action} state={state} />
      {bring.notice}
    </>
  );
}

function HostedCommitActions({ thread, state, action, reason }: Pick<PublishProps, "thread" | "state"> & { action: HostedActionController; reason: string | null }) {
  const existing = state?.pullRequest?.url ?? thread.prUrl;
  const published = state?.work.published && !state.work.unpushed && state.branch !== state.baseBranch;
  return (
    <>
      {state?.work.unpushed ? <HostedPushControl action={action} reason={reason} published={state.work.published} /> : null}
      {existing || published ? <HostedPullRequestControl thread={thread} state={state} action={action} reason={reason} /> : null}
    </>
  );
}

function HostedPublishNotice({ action, state }: { action: HostedActionController; state: HostedReviewState | undefined }) {
  const pendingElsewhere = state?.actions.find((item) => item.id !== action.request?.id);
  const observed = action.result ?? pendingElsewhere;
  const line = action.error ?? action.refusal ?? (observed ? hostedActionLine(observed) : null);
  if (!line) return null;
  const failed = Boolean(action.error || action.refusal || action.result?.state === "failed" || action.result?.state === "refused");
  return (
    <PanelNotice role={failed ? "alert" : "status"} tone={failed ? "bad" : "muted"}>
      {line}
      {action.error ? (
        <>
          {" "}
          <Button size="sm" variant="ghost" onClick={action.retry}>
            Retry
          </Button>
        </>
      ) : null}
    </PanelNotice>
  );
}
