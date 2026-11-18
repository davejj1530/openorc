import { useEffect, useId, useState, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import type { Project, PullRequestCounts, PullRequestLabel, PullRequestStateFilter, PullRequestSummary } from "@openorc/protocol";
import { RefreshCw } from "../components/icons";
import { ListGroupHeading } from "../components/ListGroupHeading";
import { LabelDot, PersonFace, PullRequestPalette, PullRequestSortMenu, PullRequestTokens } from "../components/PullRequestPalette";
import { PullRequestEditActions, PullRequestViewMenu, SaveViewDialog } from "../components/PullRequestViewMenu";
import { PullStateGlyph } from "../components/PullStateGlyph";
import { ScopedTitle } from "../components/ScopedTitle";
import { TopBar } from "../components/TopBar";
import { Button, Empty, IconButton, metaSlot, Tooltip } from "../components/ui";
import { cn } from "../lib/cn";
import { focusedProject, useLayout } from "../lib/layout";
import {
  activeView,
  builtInViews,
  hasPullRequestFilters,
  listOf,
  matchesPullRequest,
  noPullRequestFilters,
  onGitHub,
  pullRequestNarrowing,
  pullRequestTone,
  pullRequestToneLabel,
  readDefaultViewId,
  readPullRequestViews,
  rememberListState,
  reviewDecisionLabel,
  startingListState,
  stateTabs,
  watchPullRequestViews,
  writeDefaultViewId,
  writePullRequestFilters,
  writePullRequestViews,
  type PullRequestListState,
  type PullRequestView,
} from "../lib/pull-requests";
import { tagsFor, relativeTime } from "@openorc/client";
import { useRpc, useRpcs } from "../lib/client";
import { core } from "../lib/rpc";
import { openPullRequest } from "../lib/router";
import "./pull-requests.css";

function PullRequestRow({ pull, projectId }: { pull: PullRequestSummary; projectId: string }) {
  const tone = pullRequestTone(pull);
  const decision = pull.state === "open" && pull.reviewDecision ? reviewDecisionLabel[pull.reviewDecision] : null;
  return (
    <div>
      <button type="button" onClick={() => openPullRequest(projectId, pull.number)} className="pull-row" aria-label={`${pull.title}, #${pull.number}, ${pullRequestToneLabel[tone]}`}>
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
        {decision ? <span className={cn("pull-status shrink-0", `pull-status-${decision.tone}`)}>{decision.label}</span> : null}
        <span className="shrink-0 font-mono text-xs tabular">
          <span className="text-ok">+{pull.additions}</span> <span className="text-bad">-{pull.deletions}</span>
        </span>
        <span className={cn(metaSlot, "w-16 text-sm")}>{relativeTime(pull.updatedAt)}</span>
      </button>
    </div>
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

type ProjectPulls = { project: Project; pulls: PullRequestSummary[] | undefined; error: Error | null; loading: boolean; retry: () => void };

/**
 * One project's pull requests. A list of several projects names each one as a
 * group that folds away like a task group, and keeps its failures to itself.
 */
function ProjectSection({ entry, query, named }: { entry: ProjectPulls; query: string; named: boolean }) {
  const id = useId();
  const [collapsed, setCollapsed] = useState(false);
  const pulls = (entry.pulls ?? []).filter((pull) => matchesPullRequest(pull, query));
  let body: ReactNode = pulls.map((pull) => <PullRequestRow key={pull.number} pull={pull} projectId={entry.project.id} />);
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
  else if (pulls.length === 0) body = null;
  if (named && !body) return null;
  const count = entry.pulls ? { value: pulls.length, label: `${pulls.length} ${pulls.length === 1 ? "pull request" : "pull requests"}` } : null;
  return (
    <section aria-label={`${entry.project.name} pull requests`} className="list-group">
      {named ? (
        <ListGroupHeading id={`${id}-heading`} controls={`${id}-pulls`} collapsed={collapsed} onToggle={() => setCollapsed((current) => !current)} label={entry.project.name} count={count} />
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
  if (input.projects.length === 0) return { title: "No GitHub projects", body: "Import a project whose remote is on GitHub." };
  return null;
}

/** The pull requests, or why there are none to show. */
function ListBody({
  loading,
  reason,
  entries,
  list,
  onClear,
}: {
  loading: boolean;
  reason: { title: string; body: string } | null;
  entries: ProjectPulls[];
  list: PullRequestListState;
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
  const settled = entries.length > 0 && entries.every((entry) => entry.pulls || entry.error);
  const nothing = settled && entries.every((entry) => !entry.error && !(entry.pulls ?? []).some((pull) => matchesPullRequest(pull, list.query)));
  if (nothing) return <NothingFound list={list} onClear={onClear} />;
  return (
    <div className="pull-list flex-1 min-h-0 overflow-y-auto pb-4">
      {entries.map((entry) => (
        <ProjectSection key={entry.project.id} entry={entry} query={list.query} named={entries.length > 1} />
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
 * switches it, the tabs pick a state, and the palette narrows it by anything GitHub's filters can. Everything is read
 * through the user's own gh.
 */
export function PullRequestList() {
  const projectId = useLayout(focusedProject);
  const system = useRpc("system.info", {});
  const projectList = useRpc("projects.list", {});
  const { list, views, shown, edited, defaultId, change, changeDefault, saveNew, saveOver, remove } = useListViews();
  const [saving, setSaving] = useState(false);
  const narrowing = pullRequestNarrowing(list.filters);
  const { sort: _sort, ...counted } = narrowing;

  const scoped = (projectList.data ?? []).filter((project) => (projectId ? project.id === projectId : onGitHub(project.gitRemote)));
  const reason = unavailable({ ghInstalled: system.data?.gh.installed, projects: projectList.data ? scoped : [] });
  const offered = reason ? [] : scoped;
  const results = useQueries({
    queries: scoped.map((project) => {
      const params = { projectId: project.id, state: list.state, ...narrowing };
      return {
        queryKey: ["pulls.list", params],
        queryFn: () => core.call("pulls.list", params),
        meta: { tags: tagsFor("pulls.list", params) },
        enabled: !reason,
        retry: false,
      };
    }),
  });
  const countReads = useRpcs(
    "pulls.counts",
    scoped.map((project) => ({ projectId: project.id, ...counted })),
    { enabled: !reason },
  );
  // A search looks only through the pull requests loaded, which GitHub's counts know nothing of, so the tabs count
  // nothing while there is one rather than disagree with the list.
  const counts = list.query.trim() ? null : totalCounts(countReads);
  const entries: ProjectPulls[] = scoped.map((project, index) => {
    const result = results[index]!;
    return { project, pulls: result.data, error: result.error, loading: result.isPending, retry: () => void result.refetch() };
  });
  const loaded = entries.flatMap((entry) => entry.pulls ?? []);
  const labelColors = new Map(loaded.flatMap((pull) => pull.labels).map((label) => [label.name.toLowerCase(), label.color] as const));
  const refreshing = results.some((result) => result.isFetching);
  const target = { filters: list.filters, query: list.query };

  return (
    <>
      <TopBar
        actions={
          <span className="flex items-center gap-1">
            {edited ? <PullRequestEditActions shown={shown} onRevert={() => change(listOf(shown))} onSave={saveOver} onSaveNew={() => setSaving(true)} /> : null}
            <Tooltip label="Refresh">
              <IconButton aria-label="Refresh pull requests" disabled={Boolean(reason)} onClick={() => [...results, ...countReads].forEach((read) => void read.refetch())}>
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
      <div className="page-column">
        <div className="pull-toolbar">
          <StateTabs value={list.state} counts={counts} onChange={(state) => change({ state })} />
          <div className="pull-toolbar-end">
            <PullRequestPalette projects={offered} target={target} onChange={change} pulls={loaded} enabled={!reason} />
            <PullRequestSortMenu value={list.filters.sort} onChange={(sort) => change({ filters: { ...list.filters, sort } })} />
          </div>
        </div>
        <PullRequestTokens target={target} onChange={change} labelColors={labelColors} projects={offered} />
        <ListBody loading={!projectList.data || !system.data} reason={reason} entries={entries} list={list} onClear={() => change({ filters: noPullRequestFilters, query: "" })} />
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
