import { lazy, Suspense, useMemo, useState } from "react";
import type { PullRequestDetail, PullRequestReview } from "@openorc/protocol";
import type { CommentDraft } from "../components/DiffView";
import { ChevronRight, ExternalLink, RefreshCw } from "../components/icons";
import { PullRequestReviewBar } from "../components/PullRequestReviewBar";
import { PullRequestReviewer } from "../components/PullRequestReviewer";
import { RichText } from "../components/RichText";
import { TopBar } from "../components/TopBar";
import { Badge, Button, Empty, IconButton, Segmented, StatusDot, Tooltip } from "../components/ui";
import { cn } from "../lib/cn";
import { diffComment, draftAuthor, pullRequestDot, pullRequestTone, pullRequestToneLabel, reviewDecisionLabel } from "../lib/pull-requests";
import { invalidateTags, useRpc, useRpcMutation } from "../lib/client";
import { useRouter } from "../lib/router";
import { relativeTime } from "@openorc/client";
import { useModelCatalog } from "../lib/use-model-catalog";
import { useOrclings } from "../lib/orclings";

const DiffView = lazy(() => import("../components/DiffView").then((m) => ({ default: m.DiffView })));

type Section = "changes" | "description";
const sections = [
  { value: "changes", label: "Changes" },
  { value: "description", label: "Description" },
] as const;

function PullRequestHeading({ pull }: { pull: PullRequestDetail }) {
  const tone = pullRequestTone(pull);
  const decision = pull.reviewDecision ? reviewDecisionLabel[pull.reviewDecision] : null;
  return (
    <div className="shrink-0 px-6 pt-5 pb-3">
      <h1 className="text-title-sm text-ink break-words">
        {pull.title} <span className="text-ink-4">#{pull.number}</span>
      </h1>
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-3">
        <span className="inline-flex items-center gap-2 text-ink-2">
          <StatusDot tone={pullRequestDot[tone]} /> {pullRequestToneLabel[tone]}
        </span>
        <span className="min-w-0">
          {pull.author} · <span className="font-mono text-ink-2">{pull.headRefName}</span> → <span className="font-mono text-ink-2">{pull.baseRefName}</span>
        </span>
        <span className="font-mono tabular">
          <span className="text-ok">+{pull.additions}</span> <span className="text-bad">-{pull.deletions}</span>
        </span>
        <span>
          {pull.changedFiles} file{pull.changedFiles === 1 ? "" : "s"} · updated {relativeTime(pull.updatedAt)}
        </span>
        {decision ? <Badge tone={decision.tone}>{decision.label}</Badge> : null}
      </p>
    </div>
  );
}

/**
 * The diff with the draft review's comments on it. A comment is on the commit whose diff it was started on, even when
 * the diff refreshes to newer commits while it is being written.
 */
function PullRequestChanges({ projectId, pull, review }: { projectId: string; pull: PullRequestDetail; review: PullRequestReview | null }) {
  const key = { projectId, number: pull.number };
  const diff = useRpc("pulls.diff", key);
  const models = useModelCatalog();
  const orclings = useOrclings();
  const addComment = useRpcMutation("pulls.review.comment");
  const removeComment = useRpcMutation("pulls.review.removeComment");
  const [draft, setDraft] = useState<{ location: CommentDraft; commitId: string } | null>(null);
  const drafts = review?.comments;
  const comments = useMemo(() => (drafts ?? []).map(diffComment), [drafts]);
  const authors = new Map((drafts ?? []).map((comment) => [comment.id, draftAuthor(comment.author, models.data, orclings)]));
  const error = addComment.error ?? removeComment.error;
  const submitDraft = (body: string) => {
    if (!draft) return;
    const { path, startLine, startSide, line, side, lineText } = draft.location;
    addComment.mutate({ ...key, commitId: draft.commitId, path, startLine, startSide, line, side, lineText, body }, { onSuccess: () => setDraft(null) });
  };

  if (diff.error) {
    return (
      <Empty title="The changes couldn’t load" action={<Button onClick={() => void diff.refetch()}>Try again</Button>}>
        {diff.error.message}
      </Empty>
    );
  }
  if (!diff.data) return <div className="document-skeleton" aria-label="Loading changes" />;
  const { patch, headSha } = diff.data;
  if (!patch.trim()) return <Empty title="No changes">This pull request changes no files.</Empty>;
  return (
    <>
      <div className="flex-1 min-h-0 px-4">
        <Suspense fallback={null}>
          <DiffView
            patch={patch}
            comments={comments}
            commentRanges
            draft={draft?.location ?? null}
            onRequestComment={(location) => setDraft({ location, commitId: headSha })}
            onSubmitDraft={submitDraft}
            onCancelDraft={() => setDraft(null)}
            onRemoveComment={(id) => removeComment.mutate({ ...key, id })}
            commentState={(id) => ({ label: "draft", author: authors.get(id) ?? "You", removeDisabled: removeComment.isPending })}
          />
        </Suspense>
      </div>
      {error ? (
        <p role="alert" className="shrink-0 px-6 py-2 text-sm text-bad break-words">
          {error.message}
        </p>
      ) : null}
    </>
  );
}

function PullRequestDescription({ body }: { body: string }) {
  if (!body.trim()) return <Empty title="No description">The author left the description empty.</Empty>;
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
      <div className="max-w-3xl text-prose text-ink prose-chat">
        <RichText>{body}</RichText>
      </div>
    </div>
  );
}

/**
 * One pull request: its changes and description, the reviewer who drafts the
 * review, and the draft itself. Nothing reaches GitHub until you submit.
 */
export function PullRequestView({ projectId, number }: { projectId: string; number: number }) {
  const navigate = useRouter((s) => s.navigate);
  const project = useRpc("projects.get", { id: projectId });
  const pull = useRpc("pulls.get", { projectId, number });
  const review = useRpc("pulls.review.get", { projectId, number });
  const [section, setSection] = useState<Section>("changes");
  const detail = pull.data;

  let body;
  if (pull.error) {
    body = (
      <Empty title="This pull request couldn’t load" action={<Button onClick={() => void pull.refetch()}>Try again</Button>}>
        {pull.error.message}
      </Empty>
    );
  } else if (!detail) body = <div className="document-skeleton" aria-label="Loading pull request" />;
  else {
    body = (
      <>
        <PullRequestHeading pull={detail} />
        <div className="sub-header py-2">
          <Segmented label="Pull request section" value={section} onChange={setSection} options={sections} />
          <PullRequestReviewer projectId={projectId} pull={detail} review={review.data ?? null} />
        </div>
        {section === "changes" ? <PullRequestChanges projectId={projectId} pull={detail} review={review.data ?? null} /> : <PullRequestDescription body={detail.body} />}
        <PullRequestReviewBar projectId={projectId} pull={detail} review={review.data ?? null} />
      </>
    );
  }

  return (
    <>
      <TopBar
        projectId={projectId}
        projectName={project.data?.name ?? null}
        onProjectChange={() => navigate({ view: "pulls" })}
        actions={
          <>
            {detail ? (
              <Tooltip label="Open on GitHub">
                <IconButton aria-label="Open on GitHub" onClick={() => window.openorc.openExternal(detail.url)}>
                  <ExternalLink size={15} />
                </IconButton>
              </Tooltip>
            ) : null}
            <Tooltip label="Refresh">
              <IconButton aria-label="Refresh pull request" onClick={() => invalidateTags(["pulls", "pull-reviews"], { immediate: true })}>
                <RefreshCw size={15} className={cn(pull.isFetching && "animate-spin")} />
              </IconButton>
            </Tooltip>
          </>
        }
      >
        <span className="inline-flex min-w-0 items-center gap-1 text-ink">
          <button type="button" className="no-drag h-7 rounded-full px-2 text-ink-3 hover:bg-surface-2 hover:text-ink" onClick={() => navigate({ view: "pulls" })}>
            Pull requests
          </button>
          <ChevronRight size={12} className="shrink-0 text-ink-4" aria-hidden="true" />
          <span className="truncate px-1">#{number}</span>
        </span>
      </TopBar>
      {body}
    </>
  );
}
