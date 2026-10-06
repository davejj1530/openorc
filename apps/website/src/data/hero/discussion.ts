/**
 * Task discussion: the user asks two models from different providers how to
 * build a task. They disagree, and the second catches a production bug in the
 * first plan before any code exists; the user asks it to build. Comments mention
 * a model and effort the way the product does ("@Model - Effort"); each
 * mentioned model replies under the comment, and a clear work request
 * continues in a linked thread.
 */
import type { Journey, Timeline } from "./timeline";
import { branches, models, type SidebarRow } from "./workspace";

const mention = (model: { label: string; effort: string }) => `@${model.label} - ${model.effort}`;

export const discussion = {
  title: "Rate-limit the public API",
  spec: {
    goal: "Stop one client from exhausting the API for everyone else.",
    criteria: [
      { text: "100 requests per minute per API key", done: false },
      { text: "Return 429 with a Retry-After header", done: false },
      { text: "Covered by tests", done: false },
    ],
  },
  label: "API",
  mentions: { codex: mention(models.codex), claude: mention(models.claude) },
  question: {
    body: `${mention(models.codex)} ${mention(models.claude)} How should we rate-limit the public API?`,
    time: "1m ago",
  },
  replies: {
    codex: {
      author: models.codex.label,
      meta: `${models.codex.effort} · Codex`,
      body: "A token bucket per API key, kept in memory in the API process. It is fast and needs no new infrastructure.",
    },
    // The second model disagrees, and the disagreement is the point: it finds a production bug before any code exists.
    claude: {
      author: models.claude.label,
      meta: `${models.claude.effort} · Claude Code`,
      body: "That works on one server, but `deploy/fly.toml` runs **3 instances**. Each would keep its own count, so the real limit becomes 300 a minute. Keep the counts in the Redis we already use for sessions.",
    },
  },
  /** The follow-up the user types to the model that caught it: a mention picked from the popover, then the request. */
  request: {
    to: "claude" as const,
    text: "Good catch. Build it with Redis.",
    typo: { at: "Good catch. Build it with Re".length, key: "f" },
  },
  result: {
    author: models.claude.label,
    meta: `${models.claude.effort} · Claude Code`,
    body: "Building it on Redis with a sliding window per API key, so all three instances share one count. The work continues in a linked thread.",
  },
  /** The thread the build request opens: the task's own, in its worktree, working from the moment it appears. */
  thread: {
    id: "work",
    title: "Rate-limit the public API",
    branch: branches.rateLimitThread,
    providers: [{ harness: "claude", label: "Claude" }],
    show: ">replyDone",
    busy: ">replyDone",
  } satisfies SidebarRow,
  options: [
    { name: mention(models.codex), harness: "Codex" },
    { name: mention(models.claude), harness: "Claude Code" },
  ],
  copy: {
    heading: "Comments",
    help: "Mention a model to discuss this task. Clear work requests continue in a linked thread.",
    placeholder: "Leave a note, or type @ to ask a model…",
    hint: "Type @ to choose a model and effort",
  },
};

const wide: Timeline = {
  codexText: 0.6,
  codexEnd: 2.6,
  claudeStart: 2.9,
  claudeText: 3.5,
  claudeEnd: 7.4,
  focus: 8.2,
  mentionAt: 8.5,
  /** The highlight moves down to Opus 5.5 before the pick. */
  mentionNext: 9,
  pick: 9.5,
  typeStart: 9.8,
  typeEnd: 11.6,
  post: 12.1,
  replyStart: 12.6,
  replyText: 13.2,
  replyEnd: 15.8,
  replyDone: 16.6,
  end: 22.5,
};

export const discussionJourney: Journey = {
  timelines: { wide, narrow: wide },
  states: {
    view: { rest: "task" },
    // Narrow screens hide the sidebar, so it opens to show the new thread.
    sidebar: { rest: "closed", narrow: { open: ">replyDone" } },
  },
};
