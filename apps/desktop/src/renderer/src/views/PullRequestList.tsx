import { useId, useState, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import { type Project, type PullRequestFilter, type PullRequestReview, type PullRequestSummary, type ThreadSummary } from "@openorc/protocol";
import { GitMerge, GitPullRequest, GitPullRequestClosed, RefreshCw } from "../components/icons";
import { ProjectLogo } from "../components/ProjectIconPicker";
import { ListGroupHeading } from "../components/ListGroupHeading";
import { OpenOrcMark } from "../components/OpenOrcMark";
import { OrclingAvatar } from "../components/OrclingAvatar";
import { PageFilters } from "../components/PageFilters";
import { ScopedTitle } from "../components/ScopedTitle";
import { TopBar } from "../components/TopBar";
import { Button, Empty, IconButton, metaSlot, Segmented, StatusDot, Tooltip } from "../components/ui";
import { cn } from "../lib/cn";
import { focusedProject, useLayout } from "../lib/layout";
import { draftAuthor, onGitHub, pullRequestFilters, pullRequestTone, pullRow, readPullReviewer, reviewSettings, type PullRow, type PullRequestTone } from "../lib/pull-requests";
import { orclingById, useOrclings } from "../lib/orclings";
import { tagsFor, relativeTime } from "@openorc/client";
import { useRpc, useRpcMutation } from "../lib/client";
import { core } from "../lib/rpc";
import { openPullRequest, openThread } from "../lib/router";
import { useModelCatalog } from "../lib/use-model-catalog";
import "./pages.css";
import "./pull-requests.css";

const emptyTitle: Record<PullRequestFilter, string> = {
  open: "No open pull requests",
  review_requested: "Nothing waiting on your review",
  authored: "You have no open pull requests",
  closed: "No closed pull requests",
};

const GLYPHS = { open: GitPullRequest, draft: GitPullRequest, merged: GitMerge, closed: GitPullRequestClosed } as const;
/** The glyph's tone, as on a thread's row: neutral open, faint draft, green merged, red closed. */
const GLYPH_TONES: Record<PullRequestTone, string> = { open: "text-ink-3", draft: "text-ink-4", merged: "text-ok", closed: "text-bad" };

/** The reviewer the person last chose, when it was a model or an Orcling: the key beside Review starts that review. */
function useLastReviewer() {
  const saved = readPullReviewer();
  const orcling = orclingById(useOrclings(), saved.orclingId);
  const models = useModelCatalog().data;
  const settings = saved.kind === "model" ? reviewSettings(saved.choice) : null;
  if (!settings) return null;
  return { settings, orcling, name: orcling?.name ?? draftAuthor({ agent: settings.agent, model: settings.model }, models) };
}

/** Who drafts a review in this thread, by the name the review page gives them. */
function useReviewerName() {
  const orclings = useOrclings();
  const models = useModelCatalog().data;
  return (thread: ThreadSummary) => orclingById(orclings, thread.orclingId)?.name ?? draftAuthor({ agent: thread.agent, model: thread.model }, models);
}

function PullStatusCell({ row }: { row: PullRow }) {
  if (row.status.kind === "reviewing")
    return (
      <span className="pull-row-status text-ink-3">
        <OpenOrcMark size={12} working className="text-ink-3" />
        <span className="truncate">{row.status.who} is reviewing</span>
      </span>
    );
  return (
    <span className={cn("pull-row-status", row.status.tone === "attention" ? "text-attention" : "text-ink-3")}>
      <StatusDot tone={row.status.tone} />
      <span className="truncate">{row.status.word}</span>
    </span>
  );
}

function PullMoveCell({ pull, projectId, row, reviewer }: { pull: PullRequestSummary; projectId: string; row: PullRow; reviewer: ReturnType<typeof useLastReviewer> }) {
  const start = useRpcMutation("pulls.review.start");
  const move = row.move;
  if (!move) return <span className="pull-row-move" />;
  const key = (label: string, onClick: () => void) => (
    <Button size="sm" onClick={onClick}>
      {label}
    </Button>
  );
  return (
    <span className="pull-row-move">
      {move.kind === "review" ? key("Review", () => openPullRequest(projectId, pull.number)) : null}
      {move.kind === "review" && reviewer ? (
        <Button
          size="sm"
          disabled={start.isPending}
          aria-label={`Review with ${reviewer.name}`}
          data-tip={`Review with ${reviewer.name}`}
          onClick={() => start.mutate({ projectId, number: pull.number, reviewer: reviewer.settings, ...(reviewer.orcling ? { orclingId: reviewer.orcling.id } : {}) })}
        >
          {reviewer.orcling ? <OrclingAvatar orcling={reviewer.orcling} size={16} /> : null}
          <span className="pull-row-reviewer">{reviewer.name}</span>
        </Button>
      ) : null}
      {move.kind === "finish" ? key("Finish review", () => openPullRequest(projectId, pull.number)) : null}
      {move.kind === "open-thread" ? key("Open thread", () => openThread(move.threadId)) : null}
    </span>
  );
}

function PullRequestRow({ pull, projectId, row, reviewer }: { pull: PullRequestSummary; projectId: string; row: PullRow; reviewer: ReturnType<typeof useLastReviewer> }) {
  const tone = pullRequestTone(pull);
  const Glyph = GLYPHS[tone];
  const status = row.status.kind === "reviewing" ? `${row.status.who} is reviewing` : row.status.word;
  return (
    <div className="pull-row">
      <button type="button" onClick={() => openPullRequest(projectId, pull.number)} className="pull-row-open" aria-label={`${pull.title}, #${pull.number}, ${status}`}>
        <span className={cn("pull-row-lead", GLYPH_TONES[tone])} aria-hidden="true">
          <Glyph size={16} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-base text-ink" data-tip={pull.title}>
            {pull.title}
          </span>
          <span className="truncate text-sm text-ink-3">
            #{pull.number} · {pull.author} · {pull.headRefName} into {pull.baseRefName}
          </span>
        </span>
        <PullStatusCell row={row} />
        <span className="pull-row-diff tabular">
          <span className="text-ok">+{pull.additions}</span> <span className="text-bad">−{pull.deletions}</span>
        </span>
        <span className={cn(metaSlot, "pull-row-age text-sm")}>{relativeTime(pull.updatedAt)}</span>
      </button>
      <PullMoveCell pull={pull} projectId={projectId} row={row} reviewer={reviewer} />
    </div>
  );
}

type ProjectPulls = { project: Project; rows: { pull: PullRequestSummary; row: PullRow }[] | undefined; error: Error | null; loading: boolean; retry: () => void };

/**
 * One project's pull requests, the ones whose move is the person's first. A list of several projects names each one as
 * a group that folds away like a task group, counts what waits on the person, and keeps its failures to itself.
 */
function ProjectSection({ entry, named, reviewer }: { entry: ProjectPulls; named: boolean; reviewer: ReturnType<typeof useLastReviewer> }) {
  const id = useId();
  const [collapsed, setCollapsed] = useState(false);
  const rows = entry.rows ?? [];
  let body: ReactNode = rows.map(({ pull, row }) => <PullRequestRow key={pull.number} pull={pull} projectId={entry.project.id} row={row} reviewer={reviewer} />);
  if (entry.error) {
    body = (
      <p className="px-3 py-2 text-sm text-ink-3">
        {entry.error.message}{" "}
        <button type="button" className="underline hover:text-ink" onClick={entry.retry}>
          Retry
        </button>
      </p>
    );
  } else if (entry.loading) body = <p className="px-3 py-2 text-sm text-ink-3">Loading…</p>;
  else if (rows.length === 0) body = null;
  if (named && !body) return null;
  const waiting = rows.filter(({ row }) => row.yourMove).length;
  const count = waiting ? { value: waiting, label: `${waiting} waiting on you`, waiting: true } : null;
  return (
    <section aria-label={`${entry.project.name} pull requests`} className="list-group">
      {named ? (
        <ListGroupHeading
          id={`${id}-heading`}
          controls={`${id}-pulls`}
          collapsed={collapsed}
          onToggle={() => setCollapsed((current) => !current)}
          icon={<ProjectLogo project={entry.project} />}
          label={entry.project.name}
          count={count}
        />
      ) : null}
      <div id={`${id}-pulls`} hidden={collapsed}>
        {body}
      </div>
    </section>
  );
}

/** Why the list is empty before any project is asked, or null when it can load. */
function unavailable(input: { ghInstalled: boolean | undefined; projects: Project[] }): { title: string; body: string } | null {
  if (input.ghInstalled === false) return { title: "GitHub CLI not found", body: "Pull requests load through gh. Install it, then sign in with gh auth login." };
  if (input.projects.length === 0) return { title: "No GitHub projects", body: "Import a project whose remote is on GitHub." };
  return null;
}

const listQuery = (project: Project, filter: PullRequestFilter, enabled: boolean) => {
  const params = { projectId: project.id, filter };
  return { queryKey: ["pulls.list", params], queryFn: () => core.call("pulls.list", params), meta: { tags: tagsFor("pulls.list", params) }, enabled, retry: false };
};

const numbers = (pulls: PullRequestSummary[] | undefined) => new Set((pulls ?? []).map((pull) => pull.number));

/**
 * Every scoped project's pull requests in this view, each with its status and the person's move, theirs first. Beside the
 * view it asks which open pull requests want the person's review and which they opened, the local draft reviews, and
 * the threads that opened or review them.
 */
function usePullEntries(scoped: Project[], filter: PullRequestFilter, enabled: boolean) {
  const results = useQueries({ queries: scoped.map((project) => listQuery(project, filter, enabled)) });
  // Which open pull requests ask the person's review and which they opened, for the rows of every view.
  const asked = useQueries({ queries: scoped.map((project) => listQuery(project, "review_requested", enabled)) });
  const authored = useQueries({ queries: scoped.map((project) => listQuery(project, "authored", enabled && filter === "open")) });
  const threads = useRpc("threads.list", { projectIds: scoped.map((project) => project.id) }, { enabled: enabled && scoped.length > 0 }).data ?? [];
  const open = scoped.flatMap((project, index) => (filter === "closed" ? [] : (results[index]!.data ?? []).map((pull) => ({ project, pull }))));
  const reviews = useQueries({
    queries: open.map(({ project, pull }) => {
      const params = { projectId: project.id, number: pull.number };
      return { queryKey: ["pulls.review.get", params], queryFn: () => core.call("pulls.review.get", params), meta: { tags: tagsFor("pulls.review.get", params) } };
    }),
  });
  const reviewOf = new Map<string, PullRequestReview | null | undefined>(open.map(({ project, pull }, index) => [`${project.id}#${pull.number}`, reviews[index]!.data]));
  const reviewerName = useReviewerName();

  const entries: ProjectPulls[] = scoped.map((project, index) => {
    const result = results[index]!;
    const askedOfYou = filter === "review_requested" ? null : numbers(asked[index]!.data);
    const yours = filter === "authored" ? null : numbers(authored[index]!.data);
    const rows = result.data?.map((pull) => {
      const review = reviewOf.get(`${project.id}#${pull.number}`);
      const reviewThread = review?.threadId ? threads.find((thread) => thread.id === review.threadId) : undefined;
      const working = (thread: ThreadSummary) => thread.activity === "running" || thread.activity === "waiting";
      const opener = threads.find((thread) => thread.prUrl === pull.url && thread.id !== review?.threadId);
      const row = pullRow(pull, {
        askedOfYou: askedOfYou ? askedOfYou.has(pull.number) : true,
        yours: yours ? yours.has(pull.number) : filter === "authored",
        draftComments: review?.comments.length ?? 0,
        reviewing: reviewThread && working(reviewThread) ? reviewerName(reviewThread) : null,
        restingThread: opener && opener.activity === "idle" ? opener.id : null,
      });
      return { pull, row };
    });
    const ordered = rows ? [...rows.filter(({ row }) => row.yourMove), ...rows.filter(({ row }) => !row.yourMove)] : undefined;
    return { project, rows: ordered, error: result.error, loading: result.isPending, retry: () => void result.refetch() };
  });
  return { results, asked, authored, entries };
}

/**
 * Pull requests on GitHub for the focused project, or for every project on GitHub, read through the person's own gh.
 * Each row says its state as a dot and a word and ends in the next move when it is the person's: a review GitHub asks
 * of them, a draft review waiting on this Mac, or the thread of their own pull request that has changes requested.
 */
export function PullRequestList() {
  const projectId = useLayout(focusedProject);
  const system = useRpc("system.info", {});
  const projectList = useRpc("projects.list", {});
  const [filter, setFilter] = useState<PullRequestFilter>("open");
  const scoped = (projectList.data ?? []).filter((project) => (projectId ? project.id === projectId : onGitHub(project.gitRemote)));
  const reason = unavailable({ ghInstalled: system.data?.gh.installed, projects: projectList.data ? scoped : [] });
  const { results, asked, authored, entries } = usePullEntries(scoped, filter, !reason);
  const reviewer = useLastReviewer();
  const toReview = asked.reduce((sum, result) => sum + (result.data?.length ?? 0), 0);
  const refreshing = results.some((result) => result.isFetching);
  const settled = entries.length > 0 && entries.every((entry) => entry.rows || entry.error);
  const nothing = settled && entries.every((entry) => !entry.error && (entry.rows ?? []).length === 0);
  const filters = pullRequestFilters.map((option) =>
    option.value === "review_requested" && toReview > 0
      ? {
          ...option,
          label: (
            <>
              {option.label} <span className="text-attention tabular">{toReview}</span>
            </>
          ),
        }
      : option,
  );

  let body: ReactNode;
  if (!projectList.data || !system.data) body = <div className="document-skeleton" aria-label="Loading pull requests" />;
  else if (reason) body = <Empty title={reason.title}>{reason.body}</Empty>;
  else if (entries.length === 1 && entries[0]!.error) {
    body = (
      <Empty title="Pull requests couldn’t load" action={<Button onClick={entries[0]!.retry}>Try again</Button>}>
        {entries[0]!.error.message}
      </Empty>
    );
  } else if (nothing) body = <Empty title={emptyTitle[filter]} />;
  else {
    body = (
      <div className="pull-list flex-1 min-h-0 overflow-y-auto pb-4">
        {entries.map((entry) => (
          <ProjectSection key={entry.project.id} entry={entry} named={entries.length > 1} reviewer={reviewer} />
        ))}
      </div>
    );
  }

  return (
    <>
      <TopBar
        actions={
          <Tooltip label="Refresh">
            <IconButton aria-label="Refresh pull requests" disabled={Boolean(reason)} onClick={() => [...results, ...asked, ...authored].forEach((result) => void result.refetch())}>
              <RefreshCw size={15} className={cn(refreshing && "animate-spin")} />
            </IconButton>
          </Tooltip>
        }
      >
        <ScopedTitle>Pull requests</ScopedTitle>
      </TopBar>
      <div className="page-column list-page">
        <PageFilters tabs={<Segmented label="Pull request filter" value={filter} onChange={setFilter} options={filters} />} />
        {body}
      </div>
    </>
  );
}
