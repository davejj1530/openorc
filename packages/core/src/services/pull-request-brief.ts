import type { PullRequestDetail, PullRequestReview, RunMode, Thread } from "@openorc/protocol";

const PROMPT_BODY_LIMIT = 20_000;

/** The first message of a review conversation: what the author asked for, as the reviewer would read it on GitHub. */
export function reviewPrompt(detail: PullRequestDetail): string {
  const body = detail.body.trim() ? detail.body.trim().slice(0, PROMPT_BODY_LIMIT) : "No description.";
  return `Review pull request #${detail.number}: ${detail.title}\n${detail.url}\n\nBy @${detail.author}, merging ${detail.headRefName} into ${detail.baseRefName}.\n\n${body}`;
}

/** The message that starts another round in the same conversation, which remembers the last one. */
export function againPrompt(detail: PullRequestDetail, previous: string | null): string {
  const lines = [`Review pull request #${detail.number} again: ${detail.title}`];
  if (previous && previous !== detail.headSha) {
    lines.push(
      `New commits since your last review: ${previous.slice(0, 7)}..${detail.headSha.slice(0, 7)}. Your copy now has the latest code, without anything you added to it last round, and pull_request_diff with since "${previous}" shows only what changed.`,
    );
    lines.push("", "Check each of your earlier findings against the new code, and test what changed as you did the first time. Comment only on what still needs work or is new.");
  } else {
    lines.push("No commits were added since your last review. Look again, and add only findings you haven't made.");
  }
  return lines.join("\n");
}

const READ =
  "Read the changes with pull_request_diff, then the code around them in the checkout: the callers of what changed, the tests that cover it, and what the description says the change is for. Look for bugs, security problems, data loss, races, missing error handling and missing tests, and for code that will be hard to change. Skip style points a formatter or linter would catch.";

const RUN = [
  "Then run it. Your working folder is a copy made for this review: installing, building, editing files and adding throwaway tests there is expected, and none of it reaches the pull request. Get it running the way the project's README and scripts say, and again after new commits change its dependencies.",
  "Run the type check, the linter and the tests that cover the changed code. Then exercise the change itself end to end, the way its user would: start the app or server, call the changed command or endpoint, open the changed screen, and try the inputs its author likely did not, such as empty, very large, malformed, repeated and concurrent ones. Reproduce a suspected bug before you report it, and say so in a finding you could not reproduce. When a step can't run here, say what stopped it instead of leaving it out.",
].join("\n");

const READ_ONLY = "This conversation is read-only, so the code is not run: review by reading it closely.";

const COMMENT =
  "Record each finding with pull_request_comment on the changed line it is about, one finding per comment. Start with its severity in bold (Critical, Major, Minor or Nit) and one sentence naming the problem. Then say why it matters, give the evidence, and give a concrete fix. When the comment is on new-side lines and the fix replaces exactly those lines, give the fix as a fenced code block whose language is suggestion, holding the replacement lines, so it can be applied on GitHub.";

const DRAFT =
  "Read the draft as it stands with pull_request_draft, the user's own comments included. When the user asks, or a finding no longer holds, change what a comment says with pull_request_edit_comment and remove one with pull_request_delete_comment.";

/**
 * What a conversation reviewing a pull request is told on every turn. A turn that may act tests the code it reviews;
 * a planning one reads it, and says that nothing was run.
 */
export function reviewBrief(review: Pick<PullRequestReview, "number" | "baseCommit">, thread: Pick<Thread, "baseSha">, mode: RunMode): string {
  const runs = mode === "act";
  return [
    `This conversation reviews GitHub pull request #${review.number} for the user. Its code is checked out in your working folder at commit ${(thread.baseSha ?? "").slice(0, 12)}, on no branch. Its changes start from commit ${(review.baseCommit ?? "").slice(0, 12)}.`,
    READ,
    runs ? RUN : READ_ONLY,
    runs ? `${COMMENT} The evidence is what you ran and what happened, against what should have.` : `${COMMENT} The evidence is the code path that shows the problem.`,
    runs
      ? "Finish with pull_request_summary: your verdict in a sentence, ready to merge or what must change first; what the pull request does, as a short walkthrough by area; what you ran and what each run showed, passing or failing; the findings by severity; and what you could not verify. Finding nothing is a result too: say what you tested to reach it."
      : "Finish with pull_request_summary: your verdict in a sentence, ready to merge or what must change first; what the pull request does, as a short walkthrough by area; the findings by severity; and that nothing was run, with what most needs running before it merges.",
    DRAFT,
    runs
      ? "Reviewing is the whole task: do not fix the pull request, commit, push or post to GitHub. Your comments and summary are drafts. The user edits them and decides what to post. Keep your reply short: the findings live in the draft."
      : "Reviewing is the whole task: do not propose an implementation plan. Your comments and summary are drafts. The user edits them and decides what to post to GitHub; you cannot post, push or change files. Keep your reply short: the findings live in the draft.",
  ].join("\n");
}
