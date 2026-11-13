import type { CommitRange } from "@openorc/protocol";
import type { ReactNode } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { relativeTime, shortSha, type GitObject, type ObjectState } from "@openorc/client";
import { useRpc } from "../lib/client";
import { Cloud, GitBranch, GitPullRequest, Loader2, X } from "./icons";
import { ThreadLink, useThreadMedia } from "./ThreadImages";
import { SizeBlocks, SizeStat } from "./WorkMarks";

const ROW = 28;
const BRANCH_X = 15;
const BASE_X = 5;

interface Row {
  sha: string;
  subject: string;
  author: string | null;
  at: number | undefined;
  /** Made by this phase. */
  fresh: boolean;
}

/** What to ask the core for: the commits a push moved, or what the branch has that its base lacks. */
function rangeRequest(git: GitObject): { from: string | null; to: string; base: string | null } | null {
  if (!git.tip) return null;
  const moved = git.push?.ref && !git.push.ref.created ? git.push.ref.from : null;
  return { from: git.pullRequest ? null : moved, to: git.tip, base: git.pullRequest?.base ?? null };
}

/** The branch's commits as the core reads them, keyed on commits so the drawing holds after the branch moves on. */
function useCommitRange(git: GitObject): CommitRange | null {
  const scope = useThreadMedia().fileScope;
  const threadId = scope?.kind === "thread" ? scope.id : null;
  const request = rangeRequest(git);
  const range = useRpc(
    "git.commitRange",
    { threadId: threadId ?? "", from: request?.from ?? null, to: request?.to ?? "HEAD", base: request?.base ?? null },
    // A phase asks again as it commits, pushes and opens its pull request; the last answer holds until the next lands.
    { enabled: Boolean(threadId && request), staleTime: Infinity, placeholderData: keepPreviousData },
  );
  return range.data ?? null;
}

const ago = (at: number | undefined) =>
  at === undefined
    ? ""
    : relativeTime(at)
        .replace(/^just now$/, "now")
        .replace(/ ago$/, "");

function rowsOf(git: GitObject, range: CommitRange | null): Row[] {
  const made = new Set(git.commits.map((commit) => commit.sha.slice(0, 7)));
  if (!range?.commits.length) return git.commits.map((commit) => ({ sha: commit.sha, subject: commit.subject, author: null, at: commit.at, fresh: true }));
  return range.commits.map((commit) => ({ sha: commit.sha, subject: commit.subject, author: commit.author, at: commit.at, fresh: made.has(commit.sha.slice(0, 7)) }));
}

/** How far the push has gone up the lane, 0 to 1. */
function pushed(git: GitObject): number {
  const push = git.push;
  if (!push || push.state === "failed") return 0;
  return push.state === "running" ? (push.progress ?? 0.06) : 1;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Whether the drawn commits are the ones the push sent: a new branch sends them all, a moved one sends its range. */
function sentByPush(git: GitObject): boolean {
  const ref = git.push?.ref;
  return Boolean(ref?.created || (ref?.from && !git.pullRequest));
}

function originWords(git: GitObject, count: number): string {
  const push = git.push!;
  const what = count ? ` ${plural(count, "commit")}` : "";
  if (push.state === "running") return `Pushing${what} to ${push.remote}`;
  if (push.state === "failed") return push.ref?.rejected ? `${push.remote} refused the push` : "Push failed";
  return push.ref?.created ? `Published to ${push.remote}` : `Pushed${what} to ${push.remote}`;
}

/** A row's mark on the branch lane: a loader while it runs, a cross once it failed, its own icon otherwise. */
function GitMark({ state, children }: { state: ObjectState; children: ReactNode }) {
  if (state === "running")
    return (
      <span className="work-git-mark">
        <Loader2 size={14} className="tool-row-live" />
      </span>
    );
  if (state === "failed")
    return (
      <span className="work-git-mark">
        <X size={14} data-tone="bad" />
      </span>
    );
  return <span className="work-git-mark">{children}</span>;
}

/** "89a9ed1..4f2a9c1", what a push moved, or that it made the branch on the remote. */
function movedRange(push: NonNullable<GitObject["push"]>): string {
  if (push.ref?.from && push.ref.to) return `${shortSha(push.ref.from)}..${shortSha(push.ref.to)}`;
  return push.ref?.created ? "new branch" : "";
}

/** The push: where the branch goes, how far it has gone, and what it moved. */
function OriginRow({ git, count }: { git: GitObject; count: number }) {
  const push = git.push!;
  const progress = Math.round(pushed(git) * 100);
  const range = movedRange(push);
  return (
    <div className="work-git-row work-git-origin" data-state={push.state}>
      <GitMark state={push.state}>
        <Cloud size={14} />
      </GitMark>
      <span className="work-branch">{git.branch ?? push.ref?.target ?? "HEAD"}</span>
      <span className="work-git-words motion-swap">
        <span key={push.state} className="motion-arrive">
          {originWords(git, count)}
        </span>
      </span>
      <span className="work-git-spacer" />
      {push.state === "running" ? (
        <>
          {push.objects ? <span className="work-chip-note">{push.objects} objects</span> : null}
          <span className="work-chip-note work-git-percent">{push.progress === null ? "" : `${progress}%`}</span>
        </>
      ) : (
        <span className="work-chip-note work-mono">{range}</span>
      )}
    </div>
  );
}

function PullRow({ git, range }: { git: GitObject; range: CommitRange | null }) {
  const pr = git.pullRequest!;
  const stat = range?.stat;
  const words = pr.number ? <span className="work-git-number">#{pr.number}</span> : <span className="work-git-number">{pr.state === "running" ? "Opening a pull request" : "No pull request"}</span>;
  const content = (
    <>
      <GitMark state={pr.state}>
        <GitPullRequest size={14} className="work-git-open" />
      </GitMark>
      {words}
      <span className="work-git-subject">{pr.title}</span>
      <span className="work-git-spacer" />
      {stat && pr.number ? (
        <>
          <span className="work-chip-note">{plural(stat.files, "file")}</span>
          <SizeStat added={stat.added} removed={stat.removed} />
          <SizeBlocks added={stat.added} removed={stat.removed} />
        </>
      ) : null}
    </>
  );
  return (
    <div className="work-git-row work-git-pull" data-state={pr.state}>
      {pr.url ? <ThreadLink href={pr.url}>{content}</ThreadLink> : content}
    </div>
  );
}

function CommitRow({ row }: { row: Row }) {
  return (
    <div className="work-git-row work-git-commit" data-fresh={row.fresh || undefined} data-tip={`${row.sha}\n${row.subject}`}>
      <span className="work-git-subject">{row.subject}</span>
      <span className="work-git-spacer" />
      <span className="work-git-sha">{shortSha(row.sha)}</span>
      <span className="work-chip-note work-git-who">{[row.author, ago(row.at)].filter(Boolean).join(" · ")}</span>
    </div>
  );
}

/** The lanes: the branch from its base up to origin, filling as the push sends it, a dot per commit. */
function Lanes({ rows, dots, top, start, straight, progress }: { rows: number; dots: number; top: number; start: boolean; straight: boolean; progress: number }) {
  const y = (index: number) => index * ROW + ROW / 2;
  const height = (top + rows + (start ? 1 : 0)) * ROW;
  const x = straight ? BASE_X + 5 : BRANCH_X;
  const bottom = start ? y(top + rows) : y(top + rows - 1) + ROW / 2;
  const curve = start && !straight ? `M${BASE_X} ${bottom} C${BASE_X} ${bottom - ROW * 0.45}, ${BRANCH_X} ${bottom - ROW * 0.4}, ${BRANCH_X} ${bottom - ROW * 0.85}` : `M${x} ${bottom}`;
  const lane = `${curve} L${x} ${y(Math.max(0, top - 1)) + (top ? 7 : 0)}`;
  // The oldest commit leaves first: a commit counts as sent once the push has passed it on the way up.
  const sent = (index: number) => progress >= (dots - index) / (dots + 1);
  return (
    <svg className="work-git-lanes" width="22" height={height} aria-hidden="true">
      {start && !straight ? <path d={`M${BASE_X} ${bottom} L${BASE_X} ${height}`} className="work-lane-base" /> : null}
      <path d={lane} className="work-lane" />
      <path d={lane} className="work-lane-sent" pathLength={1} style={{ strokeDashoffset: 1 - progress }} />
      {Array.from({ length: dots }, (_, index) => (
        <circle key={index} cx={x} cy={y(top + index)} r={3.5} className="work-lane-dot" data-sent={sent(index) || undefined} />
      ))}
      {start ? <circle cx={straight ? x : BASE_X} cy={y(top + rows)} r={3.5} className="work-lane-dot" data-sent="" data-base="" /> : null}
    </svg>
  );
}

/**
 * A phase's Git work as its branch: the pull request it opened, the push to origin, the commits on their lane, and
 * the commit the branch left its base at. The lane fills as the push sends the commits.
 */
/** Where the drawn commits start: the remote's old tip for a push that moved a branch, else the base it left. */
function startOf(git: GitObject, range: CommitRange | null): { straight: boolean; name: string | null } {
  const moved = git.push?.ref && !git.push.ref.created && !git.pullRequest ? git.push : null;
  if (moved) return { straight: true, name: `${moved.remote}/${moved.ref!.target}` };
  return { straight: false, name: range?.base ?? git.pullRequest?.base ?? null };
}

function BranchRow({ branch }: { branch: string | null }) {
  return (
    <div className="work-git-row">
      <span className="work-git-mark">
        <GitBranch size={14} />
      </span>
      <span className="work-branch">{branch ?? "HEAD"}</span>
    </div>
  );
}

function StartRow({ start, name }: { start: NonNullable<CommitRange["start"]>; name: string | null }) {
  return (
    <div className="work-git-row work-git-commit" data-base="">
      <span className="work-git-subject">{start.subject}</span>
      {name ? <span className="work-branch">{name}</span> : null}
      <span className="work-git-spacer" />
      <span className="work-git-sha">{shortSha(start.sha)}</span>
      <span className="work-chip-note work-git-who">{[start.author, ago(start.at)].filter(Boolean).join(" · ")}</span>
    </div>
  );
}

export function GitGraph({ git }: { git: GitObject }) {
  const range = useCommitRange(git);
  const rows = rowsOf(git, range);
  // The pull request and push rows sit above the commits; with neither, the branch's own row does.
  const top = Math.max(1, Number(Boolean(git.pullRequest)) + Number(Boolean(git.push)));
  const start = range?.start ?? null;
  const more = range?.more ?? 0;
  const { straight, name } = startOf(git, range);
  return (
    <div className="work-git" data-state={git.state}>
      {rows.length || start ? <Lanes rows={rows.length + Number(more > 0)} dots={rows.length} top={top} start={Boolean(start)} straight={straight} progress={pushed(git)} /> : null}
      {git.pullRequest ? <PullRow git={git} range={range} /> : null}
      {git.push ? <OriginRow git={git} count={sentByPush(git) ? rows.length + more : 0} /> : null}
      {!git.push && !git.pullRequest ? <BranchRow branch={git.branch} /> : null}
      {rows.map((row) => (
        <CommitRow key={row.sha.slice(0, 7)} row={row} />
      ))}
      {more ? <div className="work-git-row work-git-more">{plural(more, "earlier commit")}</div> : null}
      {start ? <StartRow start={start} name={name} /> : null}
    </div>
  );
}
