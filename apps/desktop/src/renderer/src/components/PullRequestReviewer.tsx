import { useState } from "react";
import { harnessInfo, harnessLoggedIn, type ModelOption, type PullRequestDetail, type PullRequestReview, type ThreadSummary } from "@openorc/protocol";
import { LoaderCircle, Wand } from "./icons";
import { defaultChoice, ModelPicker, type ModelChoice } from "./ModelPicker";
import { Button, Segmented, TextButton } from "./ui";
import { draftAuthor, readPullReviewer, reviewSettings, writePullReviewer, type PullReviewer } from "../lib/pull-requests";
import { orclingById, useOrclings } from "../lib/orclings";
import { useRpc, useRpcMutation } from "../lib/client";
import { openThread } from "../lib/router";
import { useModelCatalog } from "../lib/use-model-catalog";
import { useEnabledHarnesses } from "../lib/enabled-harnesses";
import { CLOUD_MODEL_LIMITS } from "../lib/cloud-model-limits";

const reviewers = [
  { value: "you", label: "You" },
  { value: "model", label: "Model" },
] as const;

/**
 * The saved reviewer, with the model it would run: the one you picked, or the default of a harness you are signed in to.
 * A project only OpenOrc Cloud has is reviewed there, with a model it runs: a pick it doesn't run gives way to its default.
 */
function useReviewer(cloud: boolean) {
  const enabled = useEnabledHarnesses();
  const [reviewer, setReviewer] = useState<PullReviewer>(readPullReviewer);
  const models = useModelCatalog(cloud);
  const info = useRpc("system.info", {});
  const signedIn = !cloud && info.data ? (enabled.find((id) => harnessLoggedIn(harnessInfo(info.data, id))) ?? null) : null;
  const fallback = models.data ? defaultChoice(models.data, signedIn) : null;
  const picked = cloud && !offered(models.data, reviewer.choice) ? null : reviewer.choice;
  const choose = (next: PullReviewer) => {
    setReviewer(next);
    writePullReviewer(next);
  };
  return { reviewer, choice: picked ?? fallback, choose, models: models.data };
}

const offered = (models: ModelOption[] | undefined, choice: ModelChoice | null) => Boolean(choice && models?.some((model) => model.agent === choice.agent && model.id === choice.model));

function startLabel(starting: boolean, again: boolean): string {
  if (starting) return "Starting…";
  return again ? "Review again" : "Start review";
}

/** The review's conversation, which says so while its model is still working. */
function ReviewConversationLink({ conversation, models }: { conversation: ThreadSummary; models: ModelOption[] | undefined }) {
  const reviewing = conversation.activity !== "idle";
  const orcling = orclingById(useOrclings(), conversation.orclingId);
  const author = orcling?.name ?? draftAuthor({ agent: conversation.agent, model: conversation.model }, models);
  return (
    <TextButton underline className="inline-flex items-center gap-1.5 text-sm" onClick={() => openThread(conversation.id)} data-tip={conversation.title}>
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
  const project = useRpc("projects.get", { id: projectId });
  if (!project.data) return null;
  return <Reviewer projectId={projectId} pull={pull} review={review} cloud={project.data.rootPath === ""} />;
}

function Reviewer({ projectId, pull, review, cloud }: { projectId: string; pull: PullRequestDetail; review: PullRequestReview | null; cloud: boolean }) {
  const { reviewer, choice, choose, models } = useReviewer(cloud);
  const start = useRpcMutation("pulls.review.start");
  const thread = useRpc("threads.get", { id: review?.threadId ?? "" }, { enabled: Boolean(review?.threadId) });
  const settings = reviewSettings(choice);
  const conversation = thread.data ?? null;
  const reviewing = conversation?.activity === "running" || conversation?.activity === "waiting";
  // A later round continues the review's conversation, unless it was put away.
  const again = conversation !== null && conversation.archivedAt === null;
  const orclings = useOrclings();
  // Orclings review pull requests of projects on this Mac.
  const orcling = cloud ? null : orclingById(orclings, reviewer.orclingId);
  const begin = () => {
    if (settings) start.mutate({ projectId, number: pull.number, reviewer: settings, ...(orcling ? { orclingId: orcling.id } : {}) });
  };

  return (
    <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
      {conversation ? <ReviewConversationLink conversation={conversation} models={models} /> : null}
      <span className="text-sm text-ink-3">Reviewer</span>
      <Segmented label="Reviewer" size="sm" value={reviewer.kind} onChange={(kind) => choose({ ...reviewer, kind })} options={reviewers} />
      {reviewer.kind === "model" ? (
        <>
          <ModelPicker
            value={orcling ? { ...orcling.settings } : choice}
            onChange={(next) => choose({ kind: "model", choice: next, orclingId: null })}
            orclings={cloud ? undefined : { options: orclings, selectedId: orcling?.id ?? null, onSelect: (next) => choose({ kind: "model", choice: { ...next.settings }, orclingId: next.id }) }}
            limits={cloud ? CLOUD_MODEL_LIMITS : undefined}
            ariaLabel="Reviewer"
            disabled={start.isPending}
          />
          <Button size="sm" disabled={!settings || start.isPending || reviewing} onClick={begin}>
            <Wand size={12} /> {startLabel(start.isPending, again)}
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
