/**
 * The workflow journey: one question becomes three tasks, a discussion between
 * two models inside a task, and a change ready for review in a new thread.
 *
 * Views: "a" is the investigation thread, "task" is the first task the agent
 * created, "b" is the thread that starts when the user asks a model to build it.
 */
import type { Journey, Timeline } from "./timeline";
import { models } from "./workspace";

const mention = (model: { label: string; effort: string }) => `@${model.label} - ${model.effort}`;

export const workflow = {
  thread: {
    title: "App performance",
    prompt: "Investigate overall app performance improvements",
    typo: { at: "Investigate overall app perfor".length, key: "n" },
    intro: "Three upgrades stand out, ordered by impact.",
    table: {
      head: ["Area", "Finding", "Estimated gain"],
      rows: [
        ["Dashboard queries", "Every render refetches `listProjects` and `listThreads` together.", "40% faster first paint"],
        ["Transcript rendering", "Rows re-render on each stream event, not just the changed block.", "Smooth scrolling under load"],
        ["Startup", "Fonts and icons load before the first window paints.", "300 ms sooner to interactive"],
      ],
    },
    outro: "Want me to create tasks for these, or work on them in this thread?",
    question: {
      text: "How should we take these on?",
      options: [
        { label: "Create tasks", description: "One task per upgrade, ready for discussion." },
        { label: "Implement it", description: "Work through all three in this thread now." },
      ],
    },
    created: "Created three tasks. Each one carries the finding, the scope, and what done looks like.",
  },
  tasks: [
    { title: "Cache dashboard queries", priority: "High", label: "Performance" },
    { title: "Render transcript rows by block", priority: "Medium", label: "Performance" },
    { title: "Defer font and icon loading", priority: "Medium", label: "Performance" },
  ],
  task: {
    title: "Cache dashboard queries",
    spec: {
      goal: "Open the dashboard once per project without refetching what is already on screen.",
      scope: ["Memoize `listProjects` and `listThreads` per project.", "Invalidate the cache on thread events instead of on every render.", "Serve the first paint from the cache when it exists."],
      criteria: [
        { text: "The dashboard makes two requests on open, not one per render", done: false },
        { text: "Thread changes appear within one refresh window", done: false },
        { text: "First paint is measurably faster on a project with 50 threads", done: false },
      ],
    },
    label: "Performance",
    mentions: { codex: mention(models.codex), claude: mention(models.claude) },
    comments: {
      ask: { text: "Which of these queries repeats the most while the dashboard is open?", typo: { at: "Which of these queries repea".length, key: "r" } },
      codex: {
        author: models.codex.label,
        meta: `${models.codex.effort} · Codex`,
        body: "`listThreads`. The hook depends on the selection, so every selection change refetches all threads for the project. One memoized query per project cuts the dashboard to two requests.",
      },
      second: { text: "What do you think?", typo: { at: "What do yo".length, key: "i" } },
      claude: {
        author: models.claude.label,
        meta: `${models.claude.effort} · Claude Code`,
        body: "Agreed. Cache per project with a five-second window and invalidate on thread events. Serve the first paint from the cache so the dashboard never waits on the network.",
      },
      build: { text: "Build this.", typo: { at: "Bui".length, key: "d" } },
      result: {
        author: models.codex.label,
        meta: `${models.codex.effort} · Codex`,
        body: "Starting from the plan above: a per-project cache with event invalidation, and the first paint served from it.",
      },
    },
  },
  work: {
    title: "Cache dashboard queries",
    prompt: "Cache dashboard queries. Memoize listProjects and listThreads per project, invalidate on thread events, and serve the first paint from the cache.",
    reply:
      "Dashboard queries are cached per project. Selection changes reuse the cache, thread events invalidate it, and the first paint comes from the last known state. The dashboard now makes **two requests on open** instead of one per render.",
    change: {
      files: [
        { path: "src/dashboard/useProjects.ts", added: 18, removed: 6 },
        { path: "src/dashboard/useThreads.ts", added: 31, removed: 9 },
        { path: "src/lib/query.ts", added: 15, removed: 3 },
      ],
    },
  },
};

export const busy = { a: "aSend~aDone aPick~aCreated", b: "bStart~bDone" };

const wide: Timeline = {
  typeStart: 0.8,
  typeEnd: 5.4,
  aSend: 5.9,
  aThought: 6.8,
  aRead: 7.4,
  aRan: 8.6,
  aIntroStart: 9,
  aIntroEnd: 10,
  aTable: 10.3,
  aOutroStart: 11.2,
  aOutroEnd: 12.6,
  aQuestion: 12.9,
  aDone: 13.1,
  aSelect: 14.6,
  aPick: 15.6,
  aCreatedStart: 16,
  aCreatedEnd: 17.4,
  aCard1: 17.7,
  aCard2: 18.1,
  aCard3: 18.5,
  aCreated: 18.9,
  viewTask: 21.2,
  askFocus: 22.6,
  askMention: 23,
  askPick: 23.9,
  askTypeStart: 24.2,
  askTypeEnd: 28.4,
  askPost: 28.9,
  codexStart: 29.4,
  codexText: 30.1,
  codexEnd: 32.6,
  secondMention: 33.4,
  secondPick: 34.2,
  secondTypeStart: 34.5,
  secondTypeEnd: 36.3,
  secondPost: 36.8,
  claudeStart: 37.3,
  claudeText: 38,
  claudeEnd: 40.4,
  buildMention: 41.2,
  buildPick: 42,
  buildTypeStart: 42.3,
  buildTypeEnd: 43.6,
  buildPost: 44.1,
  resultStart: 44.6,
  resultText: 45.3,
  resultEnd: 47,
  bStart: 47.3,
  viewB: 49.6,
  bRead: 50.4,
  bEdited: 52.6,
  bReplyStart: 53,
  bReplyEnd: 55.8,
  bDone: 56.2,
  end: 62,
};

const narrow: Timeline = {
  ...wide,
  sidebarOpen: 48.4,
  viewB: 49.6,
  sidebarClose: 49.9,
};

export const workflowJourney: Journey = {
  timelines: { wide, narrow },
  states: {
    view: {
      rest: "a",
      wide: { new: "<aSend", task: "viewTask~viewB", b: ">viewB" },
      narrow: { new: "<aSend", task: "viewTask~viewB", b: ">viewB" },
    },
    sidebar: { rest: "closed", narrow: { open: "sidebarOpen~sidebarClose" } },
  },
};
