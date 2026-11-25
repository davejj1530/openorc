import { useState } from "react";
import { projectAccountChoice } from "@openorc/client";
import {
  DEFAULT_CLAUDE_ACCOUNT,
  harnessInfo,
  harnessLoggedIn,
  reviewDrafted,
  type ModelExecutionSettings,
  type ModelOption,
  type Orcling,
  type Project,
  type PullRequestDetail,
  type PullRequestReview,
  type ThreadSummary,
} from "@openorc/protocol";
import { Wand } from "./icons";
import { WorkingMark } from "./StateMark";
import { defaultChoice, ModelPicker, type ModelChoice } from "./ModelPicker";
import type { PickerAccounts } from "./ModelPickerAccounts";
import { Button, Segmented, TextButton } from "./ui";
import { draftAuthor, readPullReviewer, reviewSettings, writePullReviewer, type PullReviewer } from "../lib/pull-requests";
import { orclingById, useOrclings } from "../lib/orclings";
import { useRpc, useRpcMutation } from "../lib/client";
import { openThread } from "../lib/router";
import { useModelCatalog } from "../lib/use-model-catalog";
import { useEnabledHarnesses } from "../lib/enabled-harnesses";
import { ON_ANOTHER_ACCOUNT, useAccountsSeparate } from "../lib/accounts-separate";
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

const DRAFT_ON_ANOTHER_ACCOUNT = "This review's draft was written on another Claude account, and accounts are kept separate, so post or discard it before reviewing on another account.";

/**
 * A round on a Claude model's picked account, or while accounts are kept separate an Orcling's own, leaves a conversation
 * on another account for a fresh one; while they are, the core refuses that until the draft is posted or discarded.
 */
function useReviewRound(conversation: ThreadSummary | null, review: PullRequestReview | null, orcling: Orcling | null, picked: string | undefined) {
  const separate = useAccountsSeparate();
  const live = liveAccount(conversation);
  const asked = (candidate: Orcling | null): string | undefined => {
    if (candidate) return separate ? candidate.claudeAccountId : undefined;
    return picked;
  };
  const elsewhere = (candidate: Orcling | null) => {
    const account = asked(candidate);
    return live !== null && account !== undefined && account !== live;
  };
  const drafted = review !== null && reviewDrafted(review);
  const blocked = (candidate: Orcling | null) => (separate && elsewhere(candidate) && drafted ? { label: ON_ANOTHER_ACCOUNT.label, reason: DRAFT_ON_ANOTHER_ACCOUNT } : undefined);
  return { again: live !== null && !elsewhere(orcling), held: blocked(orcling)?.reason, blocked };
}

/** The account of the review's conversation while a later round can go on in it: none once it was put away. */
function liveAccount(conversation: ThreadSummary | null): string | null {
  return conversation !== null && conversation.archivedAt === null ? (conversation.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT) : null;
}

/**
 * The Claude accounts a Claude model's review can run on, in a project on this Mac that uses more than one: the live
 * review conversation's checked, else the project's default. The one picked goes with the next round and isn't saved.
 */
function useReviewAccounts(
  project: Project,
  conversation: ThreadSummary | null,
  reviewer: { cloud: boolean; orcling: Orcling | null; settings: ModelExecutionSettings | null },
): { picker: PickerAccounts | undefined; picked: string | undefined } {
  const [picked, setPicked] = useState<string>();
  const claudeModel = !reviewer.cloud && !reviewer.orcling && reviewer.settings?.agent === "claude";
  const list = useRpc("claude.accounts.list", {}, { enabled: claudeModel }).data;
  const choice = claudeModel && list ? projectAccountChoice(project, list) : null;
  if (!choice || choice.accounts.filter((account) => account.enabled).length < 2) return { picker: undefined, picked: undefined };
  return { picker: { accounts: choice.accounts, current: picked ?? liveAccount(conversation) ?? choice.defaultId, choose: setPicked }, picked };
}

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
      {reviewing ? <WorkingMark size={14} /> : null}
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
  return <Reviewer projectId={projectId} project={project.data} pull={pull} review={review} cloud={project.data.rootPath === ""} />;
}

function Reviewer({ projectId, project, pull, review, cloud }: { projectId: string; project: Project; pull: PullRequestDetail; review: PullRequestReview | null; cloud: boolean }) {
  const { reviewer, choice, choose, models } = useReviewer(cloud);
  const start = useRpcMutation("pulls.review.start");
  const thread = useRpc("threads.get", { id: review?.threadId ?? "" }, { enabled: Boolean(review?.threadId) });
  const settings = reviewSettings(choice);
  const conversation = thread.data ?? null;
  const reviewing = conversation?.activity === "running" || conversation?.activity === "waiting";
  const orclings = useOrclings();
  // Orclings review pull requests of projects on this Mac.
  const orcling = cloud ? null : orclingById(orclings, reviewer.orclingId);
  const accounts = useReviewAccounts(project, conversation, { cloud, orcling, settings });
  // A later round continues the review's conversation, unless it was put away or the round runs on another account.
  const round = useReviewRound(conversation, review, orcling, accounts.picked);
  const begin = () => {
    if (!settings) return;
    const by = { ...(orcling ? { orclingId: orcling.id } : {}), ...(accounts.picked ? { claudeAccountId: accounts.picked } : {}) };
    start.mutate({ projectId, number: pull.number, reviewer: settings, ...by });
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
            orclings={
              cloud
                ? undefined
                : { options: orclings, selectedId: orcling?.id ?? null, onSelect: (next) => choose({ kind: "model", choice: { ...next.settings }, orclingId: next.id }), blocked: round.blocked }
            }
            accounts={accounts.picker}
            limits={cloud ? CLOUD_MODEL_LIMITS : undefined}
            ariaLabel="Reviewer"
            disabled={start.isPending}
          />
          <Button size="sm" disabled={!settings || start.isPending || reviewing || Boolean(round.held)} data-tip={round.held} onClick={begin}>
            <Wand size={12} /> {startLabel(start.isPending, round.again)}
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
