/**
 * Agent team: one instruction to a saved team, a task large enough to need
 * several agents. The lead sets one contract for everyone; a change to it
 * reaches the member who depends on it without the user relaying it; and the
 * reviewer, seeing both halves in the shared workspace, catches a bug between
 * them that neither side would catch alone. Bylines use the app's
 * "Model - Effort" label and the default team portraits.
 */
import type { Journey, Timeline } from "./timeline";
import { models } from "./workspace";

const byline = (model: { label: string; effort: string }) => `${model.label} - ${model.effort}`;

export const members = {
  lead: { name: "Lead", model: byline(models.codex) },
  server: { name: "Server", model: byline(models.claude) },
  client: { name: "Client", model: "Grok 4.7" },
  reviewer: { name: "Reviewer", model: byline(models.claude) },
};

export type MemberKey = keyof typeof members;

export const team = {
  name: "Product team",
  version: "Version 2",
  thread: "Live dashboard updates",
  prompt: "Replace dashboard polling with live updates.",
  typo: { at: "Replace dashboard poll".length, key: "k" },
  time: "7:16 PM",
  /** Window during which the team is working. */
  busy: "send~done",
  /** Each turn in order; its id names its moments in the timeline. */
  turns: [
    {
      id: "lead",
      member: "lead",
      reply:
        "One contract for everyone: the server emits `thread.updated` with `{ id, updatedAt }` on the existing socket. **@Server** sends it, **@Client** drops polling for it, **@Reviewer** checks both sides.",
    },
    {
      id: "server",
      member: "server",
      reply: "Emitting `thread.updated` after each write. I added `version` so late events can be ignored. **@Client**, order by `version`, not by arrival.",
    },
    {
      id: "client",
      member: "client",
      reply: "Ordering by `version` from Server. Polling is gone; the dashboard updates when an event lands.",
    },
    {
      id: "review",
      member: "reviewer",
      reply:
        "Reading both sides: the server sends `updatedAt` in seconds, the client compares it to `Date.now()` in milliseconds. Every event looks older than what is on screen, so none are shown. **@Server**, send milliseconds.",
    },
    {
      id: "fix",
      member: "server",
      reply: "Fixed: `updatedAt` is in milliseconds, and a new test sends one event from write to screen.",
      change: { path: "server/events.ts", added: 6, removed: 2 },
    },
    {
      id: "wrap",
      member: "lead",
      reply: "Live updates work end to end. Ready for your review.",
    },
  ] as { id: string; member: MemberKey; reply: string; change?: { path: string; added: number; removed: number } }[],
  hints: {
    idle: "Mention @name to address a member, @everyone for the whole team. Without a mention the lead replies.",
    active: "Enter sends to the active turn where supported. Queue keeps it for the next turn.",
  },
};

const wide: Timeline = {
  typeStart: 0.9,
  typeEnd: 3.4,
  send: 3.9,
  leadStart: 4.3,
  seenLead: 4.5,
  leadText: 5,
  leadEnd: 7.9,
  serverStart: 8.2,
  seenAll: 8.3,
  serverText: 8.9,
  serverEnd: 11.4,
  clientStart: 11.7,
  clientText: 12.3,
  clientEnd: 14,
  reviewStart: 14.3,
  reviewText: 15.1,
  reviewEnd: 18.6,
  fixStart: 18.9,
  fixText: 19.7,
  fixEnd: 21.3,
  wrapStart: 21.7,
  wrapText: 22.2,
  wrapEnd: 23.3,
  done: 23.7,
  end: 29.5,
};

export const teamJourney: Journey = {
  timelines: { wide, narrow: wide },
  states: {
    view: { rest: "team" },
    sidebar: { rest: "closed" },
  },
};
