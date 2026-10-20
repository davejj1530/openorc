/**
 * Across threads, with both threads working. The user asks the Billing page
 * thread to build the page while the Plans migration thread is mid-migration in
 * its own worktree. Claude Code reads the code, sees that the data it depends
 * on is changing there, and asks that thread with thread_send before building.
 * The message joins Codex's running turn; Codex answers from its unmerged work
 * and goes back to the migration, and the page is built against the new shape.
 * Notices carry the sender's full thread id, as `threads.send` writes them.
 */
import type { Journey, Timeline } from "./timeline";
import { models } from "./workspace";

const billingId = "8d3f1a9c-2b47-4e6d-9a51-c07e3b2f6d18";
const plansId = "4b7e2c90-6f1d-4a38-b5c2-9e0d71a3f845";

export const threads = {
  a: {
    ...models.claude,
    title: "Billing page",
    earlier: {
      request: "Plan a billing page in Settings.",
      took: "41s",
      receipt: { thought: "Thought 9s", steps: "2 steps" },
      reply: "Billing fits under **Settings → Billing**, next to Members. It needs the current plan, the card on file, and past invoices.",
    },
    prompt: "Build the billing page: current plan, card, and invoices.",
    // The typed prompt slips once and is corrected, the way people type.
    typo: { at: "Build the billing page: cur".length, key: "t" },
    asked: "This page reads `user.plan`, but the **Plans migration** thread is reworking it right now in its own worktree. I asked for the new shape before building.",
    notice: {
      head: `Message from the thread "Plans migration" (id ${plansId}):`,
      details: 'It becomes user.subscription (plan, status, trialEndsAt) when this migration lands. Trial users have no card yet, so hide invoices while the status is "trialing".',
    },
    /** The message as it travels, shortened to fit its chip. */
    flight: "What does the plan look like after your migration?",
    result: "Built against `user.subscription`: plan, card, and invoices. Trial users see when their trial ends instead of an empty invoice list.",
    change: { path: "src/settings/Billing.tsx", added: 52, removed: 0 },
    /** Phase titles, as the app names a phase after the agent's narration. */
    phases: {
      read: "Reading the settings pages",
      ask: "Asking Plans migration for the plan's new shape",
      build: "Building the page against user.subscription",
    },
    headline: [
      { text: "Reading the settings pages", show: "<aSending" },
      { text: "Asking Plans migration", show: "aSending~aDone" },
      { text: "Building the billing page", show: ">aDone" },
    ],
  },
  b: {
    ...models.codex,
    title: "Plans migration",
    /** Still working on this when the scene opens. */
    request: "Move plans into subscriptions with a status.",
    notice: {
      head: `Message from the thread "Billing page" (id ${billingId}):`,
      details: "The billing page is about to read the user’s plan. What does it look like after your migration?",
    },
    flight: "user.subscription, and no invoices on trials",
    answer: "It becomes `user.subscription`, with `status` and `trialEndsAt`. Trial users have no card yet, so I told Billing page to hide invoices for them. Back to the migration.",
    phases: {
      read: "Reading the plan models",
      migrate: "Moving plans into subscriptions",
      answer: "Answering Billing page",
      resume: "Updating the billing queries",
    },
    /** The migration's edits so far, the last one under way when the scene opens. */
    edits: [
      { path: "src/db/subscriptions.ts", added: 24 },
      { path: "src/db/plans.ts", added: 6, removed: 17 },
      { path: "src/db/migrations/0042_subscriptions.ts", added: 11 },
    ],
    change: { added: 41, removed: 17 },
    headline: [
      { text: "Moving plans into subscriptions", show: "<bWork" },
      { text: "Answering Billing page", show: "bWork~bDone" },
      { text: "Updating the billing queries", show: ">bDone" },
    ],
  },
};

/** Moments when each thread's agent is working. */
export const busy = { a: "aSend~aDone bSent~aFinish", b: ">bStart" };

const wide: Timeline = {
  typeStart: 0.9,
  typeEnd: 3.5,
  aSend: 4,
  aThought: 4.8,
  aRead: 5.9,
  aSending: 6.1,
  aSent: 6.8,
  aLand: 7.1,
  aAskedStart: 7.2,
  aAskedEnd: 9,
  aDone: 9.3,
  /** When the migration turn began, before the scene opens. */
  bStart: -38,
  bWork: 7.4,
  bDetails: 8.3,
  bThought: 8.5,
  bSending: 9.5,
  bSent: 10.2,
  bLand: 10.5,
  bAnswerStart: 10.5,
  bAnswerEnd: 12.6,
  bDone: 13,
  aWork: 11.1,
  aEdited: 13.3,
  aResultStart: 13.6,
  aResultEnd: 16.4,
  aFinish: 16.8,
  end: 22.7,
};

export const handoff: Journey = {
  timelines: { wide, narrow: wide },
  states: {
    view: { rest: "a" },
    sidebar: { rest: "closed" },
  },
};
