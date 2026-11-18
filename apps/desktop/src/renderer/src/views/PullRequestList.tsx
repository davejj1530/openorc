import { useEffect, useId, useState, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import type { Project, PullRequestCounts, PullRequestLabel, PullRequestNarrowing, PullRequestReview, PullRequestStateFilter, PullRequestSummary, ThreadSummary } from "@openorc/protocol";
import { Check, ExternalLink, Link2, MessageSquare, RefreshCw } from "../components/icons";
import { ListGroupHeading } from "../components/ListGroupHeading";
import { OpenOrcMark } from "../components/OpenOrcMark";
import { OrclingAvatar } from "../components/OrclingAvatar";
import { ProjectLogo } from "../components/ProjectIconPicker";
import { LabelDot, PersonFace, PullRequestPalette, PullRequestSortMenu, PullRequestTokens } from "../components/PullRequestPalette";
import { PullRequestEditActions, PullRequestViewMenu, SaveViewDialog } from "../components/PullRequestViewMenu";
import { PullStateGlyph } from "../components/PullStateGlyph";
import { ScopedTitle } from "../components/ScopedTitle";
import { TopBar } from "../components/TopBar";
import { Button, Empty, IconButton, metaSlot, StatusDot, Tooltip } from "../components/ui";
import { cn } from "../lib/cn";
import { focusedProject, useLayout } from "../lib/layout";
import {
  activeView,
  builtInViews,
  draftAuthor,
  hasPullRequestFilters,
  listOf,
  matchesPullRequest,
  noPullRequestFilters,
  onGitHub,
  pullRequestNarrowing,
  pullRequestTone,
  pullRequestToneLabel,
  pullRow,
  readDefaultViewId,
  readPullRequestViews,
  readPullReviewer,
  rememberListState,
  reviewSettings,
  startingListState,
  stateTabs,
  watchPullRequestViews,
  writeDefaultViewId,
  writePullRequestFilters,
  writePullRequestViews,
  type PullRequestListState,
  type PullRequestView,
  type PullRow,
} from "../lib/pull-requests";
import { orclingById, useOrclings } from "../lib/orclings";
import { tagsFor, relativeTime } from "@openorc/client";
import { useRpcMutation, useRpcs } from "../lib/client";
import { useSpaceProjects, useSpaceRpc as useRpc } from "../lib/space-queries";
import { useCopy } from "../lib/use-copy";
import { core } from "../lib/rpc";
import { openPullRequest, openThread } from "../lib/router";
import { useModelCatalog } from "../lib/use-model-catalog";
import "./pages.css";
import "./pull-requests.css";

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

/**
 * One pull request: its state, title and labels, where it stands with the person as a dot and a word, its size,
 * comments and age, then the person's next move when it is theirs, and its link.
 */
function PullRequestRow({ pull, projectId, row, reviewer }: { pull: PullRequestSummary; projectId: string; row: PullRow; reviewer: ReturnType<typeof useLastReviewer> }) {
  const tone = pullRequestTone(pull);
  const status = row.status.kind === "reviewing" ? `${row.status.who} is reviewing` : row.status.word;
  const comments = `${pull.comments} ${pull.comments === 1 ? "comment" : "comments"}`;
  return (
    <div className="pull-row-item">
      <button type="button" onClick={() => openPullRequest(projectId, pull.number)} className="pull-row" aria-label={`${pull.title}, #${pull.number}, ${status}, ${comments}`}>
        <span className="pull-row-mark" data-tip={pullRequestToneLabel[tone]}>
          <PullStateGlyph state={tone} size={15} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-3">
            <span className="truncate text-base text-ink" data-tip={pull.title}>
              {pull.title}
            </span>
            <PullRequestLabels labels={pull.labels} />
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-ink-4">
            <span className="tabular">#{pull.number}</span>
            <span aria-hidden="true">·</span>
            <PersonFace login={pull.author} size={14} />
            <span>{pull.author}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">
              {pull.headRefName} → {pull.baseRefName}
            </span>
          </span>
        </span>
        <PullStatusCell row={row} />
        <span className="shrink-0 font-mono text-xs tabular">
          <span className="text-ok">+{pull.additions}</span> <span className="text-bad">-{pull.deletions}</span>
        </span>
        {/* A slot of its own, so the counts line up down the list; none is shown for no comments, as GitHub does. */}
        <span className={cn(metaSlot, "flex w-10 items-center justify-end gap-1 text-sm")} data-tip={pull.comments > 0 ? comments : undefined}>
          {pull.comments > 0 ? (
            <>
              <MessageSquare size={13} aria-hidden="true" />
              {pull.comments}
            </>
          ) : null}
        </span>
        <span className={cn(metaSlot, "pull-row-time w-16 text-sm")}>{relativeTime(pull.updatedAt)}</span>
      </button>
      <PullMoveCell pull={pull} projectId={projectId} row={row} reviewer={reviewer} />
      <span className="pull-row-actions">
        <CopyLinkButton pull={pull} />
        <IconButton size="sm" className="hover:bg-surface-3" aria-label={`Open #${pull.number} in new tab`} data-tip="Open in new tab" onClick={() => window.openorc.openExternal(pull.url)}>
          <ExternalLink size={14} />
        </IconButton>
      </span>
    </div>
  );
}

function CopyLinkButton({ pull }: { pull: PullRequestSummary }) {
  const [state, copy] = useCopy(pull.url);
  const tip = { idle: "Copy link", copied: "Link copied", error: "Couldn’t copy link" }[state];
  return (
    <IconButton size="sm" className="hover:bg-surface-3" aria-label={state === "idle" ? `Copy link to #${pull.number}` : tip} data-tip={tip} onClick={copy}>
      {state === "copied" ? <Check size={14} /> : <Link2 size={14} />}
    </IconButton>
  );
}

/** The title line shows two labels, and how many more the pull request carries. */
const SHOWN_LABELS = 2;

/** Labels after the title: each its GitHub color as a dot beside its name. */
function PullRequestLabels({ labels }: { labels: PullRequestLabel[] }) {
  if (labels.length === 0) return null;
  const rest = labels.length - SHOWN_LABELS;
  return (
    <span className="flex shrink-0 items-center gap-2.5" data-tip={rest > 0 ? labels.map((label) => label.name).join(", ") : undefined}>
      {labels.slice(0, SHOWN_LABELS).map((label) => (
        <span key={label.name} className="pull-label" data-tip={label.description || undefined}>
          <LabelDot color={label.color} className="pull-label-dot" />
          <span className="truncate">{label.name}</span>
        </span>
      ))}
      {rest > 0 ? <span className="text-xs text-ink-4 tabular">+{rest}</span> : null}
    </span>
  );
}

/** The state tabs, each with its glyph and how many pull requests it holds under the filters set. */
function StateTabs({ value, counts, onChange }: { value: PullRequestStateFilter; counts: PullRequestCounts | null; onChange: (state: PullRequestStateFilter) => void }) {
  return (
    <div role="group" aria-label="State" className="pull-state-tabs">
      {stateTabs.map((tab) => (
        <button key={tab.value} type="button" aria-pressed={value === tab.value} className="pull-state-tab" onClick={() => onChange(tab.value)}>
          <PullStateGlyph state={tab.value} />
          {tab.label}
          {counts ? <span className="pull-state-count">{counts[tab.value]}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Every repository's counts added up, once they've all come in. */
function totalCounts(reads: { data?: PullRequestCounts | undefined }[]): PullRequestCounts | null {
  if (reads.length === 0 || reads.some((read) => !read.data)) return null;
  const total: PullRequestCounts = { open: 0, draft: 0, merged: 0, closed: 0, any: 0 };
  for (const read of reads) for (const tab of stateTabs) total[tab.value] += read.data![tab.value];
  return total;
}

type PullEntry = { pull: PullRequestSummary; row: PullRow };
type ProjectPulls = { project: Project; rows: PullEntry[] | undefined; error: Error | null; loading: boolean; retry: () => void };

const listQuery = (project: Project, state: PullRequestStateFilter, narrowing: PullRequestNarrowing, enabled: boolean) => {
  const params = { projectId: project.id, state, ...narrowing };
  return { queryKey: ["pulls.list", params], queryFn: () => core.call("pulls.list", params), meta: { tags: tagsFor("pulls.list", params) }, enabled, retry: false };
};

const numbers = (pulls: PullRequestSummary[] | undefined) => new Set((pulls ?? []).map((pull) => pull.number));

/**
 * Every scoped project's pull requests in this view, each with its status and the person's move, theirs first. Beside the
 * view it asks which open pull requests want the person's review and which they opened, the draft reviews on this Mac,
 * and the threads that opened or review them.
 */
function usePullEntries(scoped: Project[], state: PullRequestStateFilter, narrowing: PullRequestNarrowing, enabled: boolean) {
  const results = useQueries({ queries: scoped.map((project) => listQuery(project, state, narrowing, enabled)) });
  // Only an open pull request can want the person's move; a list of merged or closed ones asks nothing more.
  const moves = enabled && state !== "merged" && state !== "closed";
  const asked = useQueries({ queries: scoped.map((project) => listQuery(project, "open", { review: "awaiting_you_or_team" }, moves)) });
  const authored = useQueries({ queries: scoped.map((project) => listQuery(project, "open", { authors: ["@me"] }, moves)) });
  const threads = useRpc("threads.list", { projectIds: scoped.map((project) => project.id) }, { enabled: moves && scoped.length > 0 }).data ?? [];
  const open = scoped.flatMap((project, index) => (results[index]!.data ?? []).filter((pull) => pull.state === "open").map((pull) => ({ project, pull })));
  const reviews = useQueries({
    queries: open.map(({ project, pull }) => {
      const params = { projectId: project.id, number: pull.number };
      return { queryKey: ["pulls.review.get", params], queryFn: () => core.call("pulls.review.get", params), meta: { tags: tagsFor("pulls.review.get", params) } };
    }),
  });
  const reviewOf = new Map<string, PullRequestReview | null | undefined>(open.map(({ project, pull }, index) => [`${project.id}#${pull.number}`, reviews[index]!.data]));
  const reviewerName = useReviewerName();
  const working = (thread: ThreadSummary) => thread.activity === "running" || thread.activity === "waiting";

  const entries: ProjectPulls[] = scoped.map((project, index) => {
    const result = results[index]!;
    const askedOfYou = numbers(asked[index]!.data);
    const yours = numbers(authored[index]!.data);
    const rows = result.data?.map((pull) => {
      const review = reviewOf.get(`${project.id}#${pull.number}`);
      const reviewThread = review?.threadId ? threads.find((thread) => thread.id === review.threadId) : undefined;
      const opener = threads.find((thread) => thread.prUrl === pull.url && thread.id !== review?.threadId);
      const row = pullRow(pull, {
        askedOfYou: askedOfYou.has(pull.number),
        yours: yours.has(pull.number),
        draftComments: review?.comments.length ?? 0,
        reviewing: reviewThread && working(reviewThread) ? reviewerName(reviewThread) : null,
        restingThread: opener && opener.activity === "idle" ? opener.id : null,
      });
      return { pull, row };
    });
    const ordered = rows ? [...rows.filter(({ row }) => row.yourMove), ...rows.filter(({ row }) => !row.yourMove)] : undefined;
    return { project, rows: ordered, error: result.error, loading: result.isPending, retry: () => void result.refetch() };
  });
  return { reads: [...results, ...asked, ...authored], refreshing: results.some((result) => result.isFetching), entries };
}

/**
 * One project's pull requests. A list of several projects names each one as a
 * group that folds away like a task group, and keeps its failures to itself.
 */
function ProjectSection({ entry, query, named, reviewer }: { entry: ProjectPulls; query: string; named: boolean; reviewer: ReturnType<typeof useLastReviewer> }) {
  const id = useId();
  const [collapsed, setCollapsed] = useState(false);
  const rows = (entry.rows ?? []).filter(({ pull }) => matchesPullRequest(pull, query));
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

/** An empty list after a search or filters, with the way back to everything, or an empty state tab. An order filters nothing out. */
function NothingFound({ list, onClear }: { list: PullRequestListState; onClear: () => void }) {
  if (hasPullRequestFilters({ ...list.filters, sort: "newest" }) || list.query.trim() !== "")
    return (
      <Empty title="No matching pull requests" action={<Button onClick={onClear}>Clear filters</Button>}>
        {list.query.trim() ? "Try a different search, or other filters." : "Nothing here matches these filters."}
      </Empty>
    );
  const title = stateTabs.find((tab) => tab.value === list.state)!.empty;
  return <Empty title={title} />;
}

/** Why the list is empty before any project is asked, or null when it can load. */
function unavailable(input: { ghInstalled: boolean | undefined; projects: Project[] }): { title: string; body: string } | null {
  if (input.ghInstalled === false) return { title: "GitHub CLI not found", body: "Pull requests load through gh. Install it, then sign in with gh auth login." };
  if (input.projects.length === 0) return { title: "No GitHub projects", body: "Add a project whose remote is on GitHub." };
  return null;
}

/** The pull requests, or why there are none to show. */
function ListBody({
  loading,
  reason,
  entries,
  list,
  reviewer,
  onClear,
}: {
  loading: boolean;
  reason: { title: string; body: string } | null;
  entries: ProjectPulls[];
  list: PullRequestListState;
  reviewer: ReturnType<typeof useLastReviewer>;
  onClear: () => void;
}) {
  if (loading) return <div className="document-skeleton" aria-label="Loading pull requests" />;
  if (reason) return <Empty title={reason.title}>{reason.body}</Empty>;
  const only = entries.length === 1 ? entries[0]! : null;
  if (only?.error)
    return (
      <Empty title="Pull requests couldn’t load" action={<Button onClick={only.retry}>Try again</Button>}>
        {only.error.message}
      </Empty>
    );
  const settled = entries.length > 0 && entries.every((entry) => entry.rows || entry.error);
  const nothing = settled && entries.every((entry) => !entry.error && !(entry.rows ?? []).some(({ pull }) => matchesPullRequest(pull, list.query)));
  if (nothing) return <NothingFound list={list} onClear={onClear} />;
  return (
    <div className="pull-list flex-1 min-h-0 overflow-y-auto pb-4">
      {entries.map((entry) => (
        <ProjectSection key={entry.project.id} entry={entry} query={list.query} named={entries.length > 1} reviewer={reviewer} />
      ))}
    </div>
  );
}

/**
 * The list's state and the views it can show as: the built-in ones and yours, the one showing, and the default. A
 * change edits the view showing, which may be one the list's filters came to match rather than the one it opened as.
 */
function useListViews() {
  const [list, setList] = useState<PullRequestListState>(startingListState);
  const [saved, setSaved] = useState<PullRequestView[]>(readPullRequestViews);
  const [defaultId, setDefaultId] = useState(readDefaultViewId);
  useEffect(() => rememberListState(list), [list]);
  // Another window on this page saves, deletes and defaults views too.
  useEffect(
    () =>
      watchPullRequestViews(() => {
        setSaved(readPullRequestViews());
        setDefaultId(readDefaultViewId());
      }),
    [],
  );

  const views = [...builtInViews, ...saved];
  const active = activeView(views, list);
  const shown = active ?? views.find((view) => view.id === list.base) ?? builtInViews[0]!;

  const change = (patch: Partial<PullRequestListState>) => {
    setList({ ...list, base: shown.id, ...patch });
    if (patch.filters) writePullRequestFilters(patch.filters);
  };
  // A change applies to the views as stored, so it keeps what another window saved since this one last read them.
  const changeViews = (change: (stored: PullRequestView[]) => PullRequestView[]) => {
    const next = change(readPullRequestViews());
    setSaved(next);
    writePullRequestViews(next);
  };
  const changeDefault = (id: string | null) => {
    setDefaultId(id);
    writeDefaultViewId(id);
    // With no default the page opens with the filters last set, the view's own, and so would open as it after all.
    if (!id) writePullRequestFilters(noPullRequestFilters);
  };
  // What a view keeps of the list: everything but the view it started as.
  const current = { state: list.state, filters: list.filters, query: list.query };
  const saveNew = (name: string, makeDefault: boolean) => {
    const existing = readPullRequestViews().find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    const view: PullRequestView = { id: existing?.id ?? crypto.randomUUID(), name, ...current };
    changeViews((stored) => (existing ? stored.map((entry) => (entry.id === existing.id ? view : entry)) : [...stored, view]));
    if (makeDefault) changeDefault(view.id);
    change({ base: view.id });
  };
  const saveOver = () => changeViews((stored) => stored.map((view) => (view.id === shown.id ? { ...view, ...current } : view)));
  const remove = (view: PullRequestView) => {
    changeViews((stored) => stored.filter((entry) => entry.id !== view.id));
    if (view.id === defaultId) changeDefault(null);
    change(listOf(builtInViews[0]!));
  };
  return { list, views, shown, edited: !active, defaultId, change, changeDefault, saveNew, saveOver, remove };
}

/**
 * Pull requests on GitHub for the selected project, or for every project on GitHub, as a view: the title names it and
 * switches it, the tabs pick a state, and the palette narrows it by anything GitHub's filters can. Each row says where
 * it stands with the person and ends in their next move when it is theirs: a review GitHub asks of them, a draft review
 * waiting on this Mac, or the thread of their own pull request that has changes requested. Everything is read through
 * the user's own gh.
 */
export function PullRequestList() {
  const projectId = useLayout(focusedProject);
  const system = useRpc("system.info", {});
  // A project only the cloud has is read on GitHub by its name, as one with a folder here is read in it.
  const projectList = useSpaceProjects();
  const { list, views, shown, edited, defaultId, change, changeDefault, saveNew, saveOver, remove } = useListViews();
  const [saving, setSaving] = useState(false);
  const narrowing = pullRequestNarrowing(list.filters);
  const { sort: _sort, ...counted } = narrowing;

  const scoped = (projectList.data ?? []).filter((project) => (projectId ? project.id === projectId : onGitHub(project.gitRemote)));
  const reason = unavailable({ ghInstalled: system.data?.gh.installed, projects: projectList.data ? scoped : [] });
  const offered = reason ? [] : scoped;
  const { reads, refreshing, entries } = usePullEntries(scoped, list.state, narrowing, !reason);
  const reviewer = useLastReviewer();
  const countReads = useRpcs(
    "pulls.counts",
    scoped.map((project) => ({ projectId: project.id, ...counted })),
    { enabled: !reason },
  );
  // A search looks only through the pull requests loaded, which GitHub's counts know nothing of, so the tabs count
  // nothing while there is one rather than disagree with the list.
  const counts = list.query.trim() ? null : totalCounts(countReads);
  const loaded = entries.flatMap((entry) => (entry.rows ?? []).map(({ pull }) => pull));
  const labelColors = new Map(loaded.flatMap((pull) => pull.labels).map((label) => [label.name.toLowerCase(), label.color] as const));
  const target = { filters: list.filters, query: list.query };

  return (
    <>
      <TopBar
        actions={
          <span className="flex items-center gap-1">
            {edited ? <PullRequestEditActions shown={shown} onRevert={() => change(listOf(shown))} onSave={saveOver} onSaveNew={() => setSaving(true)} /> : null}
            <Tooltip label="Refresh">
              <IconButton aria-label="Refresh pull requests" disabled={Boolean(reason)} onClick={() => [...reads, ...countReads].forEach((read) => void read.refetch())}>
                <RefreshCw size={15} className={cn(refreshing && "animate-spin")} />
              </IconButton>
            </Tooltip>
          </span>
        }
      >
        <ScopedTitle>
          <PullRequestViewMenu
            views={views}
            shown={shown}
            edited={edited}
            defaultId={defaultId}
            onApply={(view) => change(listOf(view))}
            onSaveNew={() => setSaving(true)}
            onDefault={changeDefault}
            onDelete={remove}
          />
        </ScopedTitle>
      </TopBar>
      <div className="page-column list-page">
        <div className="pull-toolbar">
          <StateTabs value={list.state} counts={counts} onChange={(state) => change({ state })} />
          <div className="pull-toolbar-end">
            <PullRequestPalette projects={offered} target={target} onChange={change} pulls={loaded} enabled={!reason} />
            <PullRequestSortMenu value={list.filters.sort} onChange={(sort) => change({ filters: { ...list.filters, sort } })} />
          </div>
        </div>
        <PullRequestTokens target={target} onChange={change} labelColors={labelColors} projects={offered} />
        <ListBody loading={!projectList.data || !system.data} reason={reason} entries={entries} list={list} reviewer={reviewer} onClear={() => change({ filters: noPullRequestFilters, query: "" })} />
      </div>
      {saving ? (
        <SaveViewDialog
          state={list}
          onSave={(name, makeDefault) => {
            saveNew(name, makeDefault);
            setSaving(false);
          }}
          onClose={() => setSaving(false)}
        />
      ) : null}
    </>
  );
}
