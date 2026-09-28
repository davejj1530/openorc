import { useState } from "react";
import {
  harnessIds,
  harnessInfo,
  harnessLoggedIn,
  isHarnessId,
  type ModelExecutionSettings,
  type ModelOption,
  type PullRequestDetail,
  type PullRequestReview,
  type ThreadSummary,
} from "@openorc/protocol";
import { LoaderCircle, Sparkles } from "./icons";
import { defaultChoice, ModelPicker, type ModelChoice } from "./ModelPicker";
import { Button, Segmented, TextButton } from "./ui";
import { draftAuthor, readPullReviewer, writePullReviewer, type PullReviewer } from "../lib/pull-requests";
import { useRpc, useRpcMutation } from "../lib/query";
import { openThread } from "../lib/router";
import { useModelCatalog } from "../lib/use-model-catalog";

const reviewers = [
  { value: "you", label: "You" },
  { value: "model", label: "Model" },
] as const;

/** The saved reviewer, with the model it would run: the one you picked, or the default of a harness you are signed in to. */
function useReviewer() {
  const [reviewer, setReviewer] = useState<PullReviewer>(readPullReviewer);
  const models = useModelCatalog();
  const info = useRpc("system.info", {});
  const signedIn = info.data ? (harnessIds.find((id) => harnessLoggedIn(harnessInfo(info.data, id))) ?? null) : null;
  const fallback = models.data ? defaultChoice(models.data, signedIn) : null;
  const choose = (next: PullReviewer) => {
    setReviewer(next);
    writePullReviewer(next);
  };
  return { reviewer, choice: reviewer.choice ?? fallback, choose, models: models.data };
}

/** What a review run needs from a picker choice; null for a model no harness can run. */
function reviewSettings(choice: ModelChoice | null): ModelExecutionSettings | null {
  if (!choice || !isHarnessId(choice.agent)) return null;
  return { agent: choice.agent, model: choice.model, effort: choice.effort, fastMode: Boolean(choice.fastMode) };
}

/** The review's conversation, which says so while its model is still working. */
function ReviewConversationLink({ conversation, models }: { conversation: ThreadSummary; models: ModelOption[] | undefined }) {
  const reviewing = conversation.activity !== "idle";
  const author = draftAuthor({ agent: conversation.agent, model: conversation.model }, models);
  return (
    <TextButton underline className="inline-flex items-center gap-1.5 text-sm" onClick={() => openThread(conversation.id)} title={conversation.title}>
      {reviewing ? <LoaderCircle size={13} className="animate-spin" aria-hidden="true" /> : null}
      {reviewing ? `${author} is reviewing` : "Review conversation"}
    </TextButton>
  );
}

/**
 * Who drafts the review. You can always comment on lines yourself; choosing a
 * model starts it reviewing in a conversation of its own, and its comments
 * join the same draft. Either way, only you post to GitHub.
 */
export function PullRequestReviewer({ projectId, pull, review }: { projectId: string; pull: PullRequestDetail; review: PullRequestReview | null }) {
  const { reviewer, choice, choose, models } = useReviewer();
  const start = useRpcMutation("pulls.review.start");
  const thread = useRpc("threads.get", { id: review?.threadId ?? "" }, { enabled: Boolean(review?.threadId) });
  const settings = reviewSettings(choice);
  const conversation = thread.data ?? null;
  const reviewing = conversation?.activity === "running" || conversation?.activity === "waiting";
  const begin = () => {
    if (settings) start.mutate({ projectId, number: pull.number, reviewer: settings });
  };

  return (
    <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
      {conversation ? <ReviewConversationLink conversation={conversation} models={models} /> : null}
      <span className="text-sm text-ink-3">Reviewer</span>
      <Segmented label="Reviewer" size="sm" value={reviewer.kind} onChange={(kind) => choose({ ...reviewer, kind })} options={reviewers} />
      {reviewer.kind === "model" ? (
        <>
          <ModelPicker value={choice} onChange={(next) => choose({ kind: "model", choice: next })} ariaLabel="Reviewing model" disabled={start.isPending} />
          <Button size="sm" disabled={!settings || start.isPending || reviewing} onClick={begin}>
            <Sparkles size={12} /> {start.isPending ? "Starting…" : "Start review"}
          </Button>
        </>
      ) : null}
      {start.error ? (
        <p role="alert" className="basis-full text-right text-sm text-bad break-words">
          {start.error.message}
        </p>
      ) : null}
    </div>
  );
}
