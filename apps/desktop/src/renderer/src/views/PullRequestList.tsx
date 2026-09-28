import { useState, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import { WORKSPACE_ID, type Project, type PullRequestFilter, type PullRequestSummary } from "@openorc/protocol";
import { GitPullRequest, RefreshCw, Search } from "../components/icons";
import { TopBar } from "../components/TopBar";
import { Badge, Button, Empty, IconButton, metaSlot, Segmented, Tooltip } from "../components/ui";
import { cn } from "../lib/cn";
import { useLayout } from "../lib/layout";
import { matchesPullRequest, onGitHub, pullRequestFilters, pullRequestTone, pullRequestToneClass, pullRequestToneLabel, reviewDecisionLabel } from "../lib/pull-requests";
import { tagsFor, useRpc } from "../lib/query";
import { core } from "../lib/rpc";
import { openPullRequest } from "../lib/router";
import { relativeTime } from "../lib/time";

const emptyTitle: Record<PullRequestFilter, string> = {
  open: "No open pull requests",
  review_requested: "Nothing waiting on your review",
  authored: "You have no open pull requests",
  closed: "No closed pull requests",
};

function PullRequestRow({ pull, projectId }: { pull: PullRequestSummary; projectId: string }) {
  const tone = pullRequestTone(pull);
  const decision = pull.reviewDecision ? reviewDecisionLabel[pull.reviewDecision] : null;
  // A merged or closed pull request says so in words as well as in the icon's color.
  const ended = pull.state === "open" ? "" : `${pullRequestToneLabel[tone]} · `;
  return (
    <div className="mx-3 border-t border-line first:border-t-0 last:border-b">
      <button
        type="button"
        onClick={() => openPullRequest(projectId, pull.number)}
        className="flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left hover:bg-surface-2"
        aria-label={`${pull.title}, #${pull.number}, ${pullRequestToneLabel[tone]}`}
      >
        <GitPullRequest size={15} className={cn("mt-0.5 shrink-0 self-start", pullRequestToneClass[tone])} aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-base text-ink" title={pull.title}>
            {pull.title}
          </span>
          <span className="truncate text-sm text-ink-3">
            #{pull.number} · {ended}
            {pull.author} · {pull.headRefName} → {pull.baseRefName}
          </span>
        </span>
        {pull.isDraft ? <Badge className="shrink-0">Draft</Badge> : null}
        {decision ? (
          <Badge tone={decision.tone} className="shrink-0">
            {decision.label}
          </Badge>
        ) : null}
        <span className="shrink-0 font-mono text-xs tabular">
          <span className="text-ok">+{pull.additions}</span> <span className="text-bad">-{pull.deletions}</span>
        </span>
        <span className={cn(metaSlot, "w-16 text-sm")}>{relativeTime(pull.updatedAt)}</span>
      </button>
    </div>
  );
}

type ProjectPulls = { project: Project; pulls: PullRequestSummary[] | undefined; error: Error | null; loading: boolean; retry: () => void };

/** One project's pull requests; a list of several projects names each and keeps its failures to itself. */
function ProjectSection({ entry, query, named }: { entry: ProjectPulls; query: string; named: boolean }) {
  const pulls = (entry.pulls ?? []).filter((pull) => matchesPullRequest(pull, query));
  let body: ReactNode = pulls.map((pull) => <PullRequestRow key={pull.number} pull={pull} projectId={entry.project.id} />);
  if (entry.error) {
    body = (
      <p className="mx-3 border-t border-line px-3 py-2 text-sm text-ink-3">
        {entry.error.message}{" "}
        <button type="button" className="underline hover:text-ink" onClick={entry.retry}>
          Retry
        </button>
      </p>
    );
  } else if (entry.loading) body = <p className="mx-3 border-t border-line px-3 py-2 text-sm text-ink-3">Loading…</p>;
  else if (pulls.length === 0) body = null;
  if (named && !body) return null;
  return (
    <section aria-label={`${entry.project.name} pull requests`}>
      {named ? (
        <h2 className="well-fill sticky top-0 z-10 mx-3 pt-2">
          <span className="flex h-8 items-center gap-2 rounded-t-md bg-surface-2 px-3 text-sm font-medium text-ink-2">
            {entry.project.name}
            {entry.pulls ? <span className="text-ink-4 tabular">{pulls.length}</span> : null}
          </span>
        </h2>
      ) : null}
      {body}
    </section>
  );
}

/** Why the list is empty before any project is asked, or null when it can load. */
function unavailable(input: { ghInstalled: boolean | undefined; projectId: string | null; projects: Project[] }): { title: string; body: string } | null {
  if (input.ghInstalled === false) return { title: "GitHub CLI not found", body: "Pull requests load through gh. Install it, then sign in with gh auth login." };
  if (input.projectId === WORKSPACE_ID) return { title: "Workspace has no pull requests", body: "Choose a project from the header." };
  if (input.projects.length === 0) return { title: "No GitHub projects", body: "Import a project whose remote is on GitHub." };
  return null;
}

/**
 * Open pull requests on GitHub for the selected project, or for every project
 * on GitHub. Everything is read through the user's own gh.
 */
export function PullRequestList() {
  const projectId = useLayout((s) => s.projectId);
  const system = useRpc("system.info", {});
  const projectList = useRpc("projects.list", {});
  const [filter, setFilter] = useState<PullRequestFilter>("open");
  const [query, setQuery] = useState("");
  const scoped = (projectList.data ?? []).filter((project) => (projectId ? project.id === projectId : onGitHub(project.gitRemote)));
  const reason = unavailable({ ghInstalled: system.data?.gh.installed, projectId, projects: projectList.data ? scoped : [] });
  const results = useQueries({
    queries: scoped.map((project) => {
      const params = { projectId: project.id, filter };
      return {
        queryKey: ["pulls.list", params],
        queryFn: () => core.call("pulls.list", params),
        meta: { tags: tagsFor("pulls.list", params) },
        enabled: !reason,
        retry: false,
      };
    }),
  });
  const entries: ProjectPulls[] = scoped.map((project, index) => {
    const result = results[index]!;
    return { project, pulls: result.data, error: result.error, loading: result.isPending, retry: () => void result.refetch() };
  });
  const refreshing = results.some((result) => result.isFetching);
  const settled = entries.length > 0 && entries.every((entry) => entry.pulls || entry.error);
  const nothing = settled && entries.every((entry) => !entry.error && (entry.pulls ?? []).filter((pull) => matchesPullRequest(pull, query)).length === 0);

  let body: ReactNode;
  if (!projectList.data || !system.data) body = <div className="document-skeleton" aria-label="Loading pull requests" />;
  else if (reason) body = <Empty title={reason.title}>{reason.body}</Empty>;
  else if (entries.length === 1 && entries[0]!.error) {
    body = (
      <Empty title="Pull requests couldn’t load" action={<Button onClick={entries[0]!.retry}>Try again</Button>}>
        {entries[0]!.error.message}
      </Empty>
    );
  } else if (nothing) body = <Empty title={query ? "No matching pull requests" : emptyTitle[filter]}>{query ? "Try a different title, number, author or branch." : null}</Empty>;
  else {
    body = (
      <div className="pull-list flex-1 min-h-0 overflow-y-auto pb-4">
        {entries.map((entry) => (
          <ProjectSection key={entry.project.id} entry={entry} query={query} named={entries.length > 1} />
        ))}
      </div>
    );
  }

  return (
    <>
      <TopBar
        actions={
          <Tooltip label="Refresh">
            <IconButton aria-label="Refresh pull requests" disabled={Boolean(reason)} onClick={() => results.forEach((result) => void result.refetch())}>
              <RefreshCw size={15} className={cn(refreshing && "animate-spin")} />
            </IconButton>
          </Tooltip>
        }
      >
        Pull requests
      </TopBar>
      <div className="sub-header py-2">
        <Segmented label="Pull request filter" value={filter} onChange={setFilter} options={pullRequestFilters} />
        <label className="flex min-w-0 items-center gap-2 ml-auto text-ink-3">
          <Search size={13} />
          <input
            aria-label="Filter pull requests"
            className="bg-transparent min-w-0 w-40 text-sm py-1 placeholder:text-ink-4"
            value={query}
            placeholder="Filter pull requests…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      {body}
    </>
  );
}
