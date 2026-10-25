import { hasUnpushed, shortSha, type PublishView } from "@openorc/client";
import type { Commit, PushState, ThreadSummary } from "@openorc/protocol";

/** A write whose answer never came: the link dropped while the Mac may have acted. What it needs to settle it from reads. */
export type Lost = { action: "commit"; message: string; headBefore: string | null } | { action: "push" } | { action: "pr" };
export type PublishAction = Lost["action"];

/** Where a thread's publishing is: nothing running, a write out, a write lost with the link, or what the last one did. */
export type Publishing =
  { kind: "idle" } | { kind: "running"; action: PublishAction } | { kind: "lost"; lost: Lost } | { kind: "notice"; action: PublishAction; text: string; tone: "muted" | "bad"; details: string | null };

export const pullWords = { open: "PR open", merged: "PR merged", closed: "PR closed" } as const;

/** "Opened pull request #12": the number, since the URL wraps three times at phone width. */
export function openedNotice(url: string): string {
  const number = /\/pull\/(\d+)\/?$/.exec(url)?.[1];
  return number ? `Opened pull request #${number}` : "Opened pull request";
}

/** A message's subject as Git stores it from `commit -m`: its first paragraph, each line's trailing blanks off, joined with spaces. */
export function storedSubject(message: string): string {
  const lines = message.split("\n").map((line) => line.replace(/[ \t\v\f\r]+$/, ""));
  const start = lines.findIndex((line) => line !== "");
  if (start < 0) return "";
  const end = lines.indexOf("", start);
  return lines.slice(start, end < 0 ? undefined : end).join(" ");
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a subject the log shows is `subject`; a secret the Mac redacted from the log stands for any text. */
function sameSubject(shown: string, subject: string): boolean {
  const pattern = shown
    .split(/\[redacted:[a-z0-9-]+\]/)
    .map(escape)
    .join("[\\s\\S]+");
  return new RegExp(`^${pattern}$`).test(subject);
}

/**
 * The commit a lost commit made, if the log shows it: the head moved past `headBefore` to a commit with the message's
 * subject. A commit-msg hook that kept the subject's words and added its own (a ticket, a prefix) still counts when the
 * commit sits right on `headBefore`. A subject rewritten past that does not: nothing then ties the commit to the
 * message, and a Committed that might be someone else's would be a wrong settled notice. Not done costs little, as the
 * commit tops the list and Commit reads "Nothing to commit."
 */
function madeCommit(lost: Extract<Lost, { action: "commit" }>, log: Commit[]): Commit | null {
  const [head, parent] = log;
  if (!head || head.sha === lost.headBefore) return null;
  const subject = storedSubject(lost.message);
  const past = lost.headBefore === null || log.some((commit) => commit.sha === lost.headBefore);
  if (past && sameSubject(head.subject, subject)) return head;
  const onTop = lost.headBefore === null || parent?.sha === lost.headBefore;
  return onTop && subject !== "" && head.subject.includes(subject) ? head : null;
}

/**
 * What a lost write did, from fresh reads after the link came back and the Mac finished every write in the workspace: a
 * commit made the log's head, a push left origin lacking nothing, a pull request is on the thread. Writes are never
 * sent again.
 */
export function settleLost(lost: Lost, read: { log: Commit[]; push: PushState; thread: ThreadSummary }): { kind: "done"; notice: string } | { kind: "not-done" } {
  switch (lost.action) {
    case "commit": {
      const made = madeCommit(lost, read.log);
      return made ? { kind: "done", notice: `Committed ${shortSha(made.sha)}` } : { kind: "not-done" };
    }
    case "push":
      return hasUnpushed(read.push) ? { kind: "not-done" } : { kind: "done", notice: `Pushed ${read.push.branch} to origin` };
    case "pr":
      return read.thread.prUrl ? { kind: "done", notice: openedNotice(read.thread.prUrl) } : { kind: "not-done" };
  }
}

/** A pill of the publish bar: its step, and whether it is the bar's one ink pill. */
export interface BarPill {
  action: PublishAction;
  label: string;
  reason: string | null;
  running: boolean;
  ink: boolean;
}

/** The steps the bar can offer now, in the flow's order: Commit with files to commit, Push, then the pull request. */
function available(view: PublishView, files: number): Omit<BarPill, "ink">[] {
  const steps: Omit<BarPill, "ink">[] = [];
  if (view.commit && files > 0) steps.push({ action: "commit", ...view.commit });
  if (view.push) steps.push({ action: "push", ...view.push });
  const pr = view.pullRequest;
  if (pr?.kind === "exists") steps.push({ action: "pr", label: pullWords[pr.state], reason: null, running: false });
  else if (pr) steps.push({ action: "pr", ...pr.step });
  return steps;
}

/**
 * At most two pills: the next step in ink, then the next one after it in plain fill. GitHub's compare page and a pull
 * request that exists stay plain, as they leave the app.
 */
export function barPills(view: PublishView, files: number): BarPill[] {
  const steps = available(view, files);
  const plain = view.pullRequest?.kind === "compare" || view.pullRequest?.kind === "exists";
  const inked = steps.findIndex((step) => step.action === view.next && !(step.action === "pr" && plain));
  const first = Math.max(0, inked);
  return steps.slice(first, first + 2).map((step, index) => ({ ...step, ink: index === 0 && inked >= 0 }));
}

export interface Notice {
  text: string;
  tone: "muted" | "bad";
  /** The full text behind a failure's first lines. */
  details: string | null;
}

export interface NoticeInput {
  publishing: Publishing;
  /** Why the pill the reader pressed is dim, until the reason goes away. */
  asked: string | null;
  team: boolean;
  pushBlocked: string | null;
  /** Whether the publish bar shows. */
  bar: boolean;
  unpushed: boolean;
  uncommitted: number;
  mac: string;
}

const quiet = (text: string): Notice => ({ text, tone: "muted", details: null });

/** Whether the last write's words still hold: a push's until the branch moves, Committed until new changes arrive. */
function holds(notice: Extract<Publishing, { kind: "notice" }>, { unpushed, uncommitted }: NoticeInput): boolean {
  if (notice.action === "push") return notice.tone === "bad" ? unpushed : !unpushed;
  // A refused commit or pull request is told in its own sheet.
  if (notice.tone === "bad") return false;
  return notice.action === "commit" ? uncommitted === 0 : true;
}

/** The one line above the publish bar, most pressing first. */
export function noticeLine(input: NoticeInput): Notice | null {
  const { publishing } = input;
  if (publishing.kind === "lost") return quiet(`Lost ${input.mac} before it answered.`);
  if (input.asked) return quiet(input.asked);
  if (input.team) return quiet("Publish a team's work on your Mac.");
  if (publishing.kind === "notice" && holds(publishing, input)) return { text: publishing.text, tone: publishing.tone, details: publishing.details };
  return input.bar && input.pushBlocked ? quiet(input.pushBlocked) : null;
}
