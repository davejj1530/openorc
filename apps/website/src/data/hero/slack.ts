/**
 * Slack: a channel mention becomes a thread with a live approval from the desktop agent.
 * As the app does, each request gets one progress message that names the model and
 * tool at work and is edited into the reply when the turn ends. Every bot message
 * starts by mentioning the owner. The agent is Claude Code in Slack's default mode,
 * Review everything, so an edit asks first.
 */
import type { Journey, Timeline } from "./timeline";
import { models } from "./workspace";

export const slack = {
  channel: "engineering",
  user: { name: "David", initials: "DC" },
  bot: { name: "OpenOrc" },
  /** Message times: the mention and first reply, then the follow-up and what it starts. */
  times: { first: "9:41 AM", second: "9:42 AM" },
  message: "The studio welcome screen gives people too many choices. Can you simplify it?",
  reply: "Should “Connect a project” be the one clear next step?",
  followup: "Yes. Keep the layout, but make that the main action.",
  progress: {
    reading: `Working · ${models.claude.label} · Read`,
    editing: `Working · ${models.claude.label} · Edit`,
    waiting: "Waiting for your approval or answer",
  },
  /** The request names the tool and its input, shortened here. */
  permission: {
    tool: "Edit",
    input: '{ "file_path": "…/studio/src/Welcome.tsx", … }',
  },
};

const wide: Timeline = {
  message: 0,
  progress: 1.2,
  reply: 2.8,
  draftStart: 4.6,
  draftEnd: 8,
  followup: 8.2,
  working: 9.2,
  permission: 11.5,
  end: 19,
};

export const slackJourney: Journey = {
  timelines: { wide, narrow: wide },
  states: {},
};
