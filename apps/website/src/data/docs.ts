export interface DocPage {
  slug: string;
  title: string;
  /** Shorter name for navigation, when the page title is written as a heading. */
  label?: string;
  description: string;
}

export interface DocGroup {
  title: string;
  pages: DocPage[];
}

export interface DocSection {
  id: string;
  title: string;
}

/** When these pages were last checked against the source. Update it when a page is revised. */
export const docsReviewed = { date: "October 5, 2026" };

/** The sidebar, in reading order. Groups are named after parts of the app, as on Cursor's docs. */
export const docGroups: DocGroup[] = [
  {
    title: "Get started",
    pages: [
      {
        slug: "",
        title: "OpenOrc documentation",
        label: "Welcome",
        description: "Run Codex, Claude Code, and OpenCode side by side, plan the work in tasks, and review every change before it ships.",
      },
      { slug: "quickstart", title: "Quickstart", description: "Install OpenOrc, add a project, and finish your first change in a few minutes." },
      { slug: "concepts", title: "Core concepts", description: "Projects, threads, turns, tasks, and the other ideas the rest of these pages build on." },
    ],
  },
  {
    title: "Threads",
    pages: [
      { slug: "threads", title: "Threads", description: "A thread is a conversation with a coding agent about your code. Start one, steer it while it works, and pick it up later." },
      { slug: "agents", title: "Agents and models", description: "Choose Codex, Claude Code, or OpenCode for each thread, then the model and effort that fit the job." },
      { slug: "permissions", title: "Modes and permissions", description: "Decide how much an agent may do on its own, from planning only to editing and running commands." },
      { slug: "work", title: "Following the work", description: "Read what an agent is doing while it works, see what it changed, and undo a turn." },
      { slug: "messaging", title: "Threads working together", description: "Let threads message each other and start helper threads, so separate pieces of work stay in step." },
      {
        slug: "orclings",
        title: "Orclings",
        description: "Companions you design, each with its own conversation, instructions, and private memory. Think something through with one, or bring it into project work.",
      },
    ],
  },
  {
    title: "Tasks",
    pages: [
      { slug: "tasks", title: "Tasks", description: "Plan work as tasks with a status, a priority, and a written spec, then start them when you are ready." },
      { slug: "discussions", title: "Task discussions", description: "Ask one or more models about a task before anyone builds it, then hand the work to a thread." },
      { slug: "schedules", title: "Schedules", description: "Run a prompt on a project on a timer, from every 30 minutes to once a week, while OpenOrc is open." },
    ],
  },
  {
    title: "Code and review",
    pages: [
      { slug: "review", title: "Changes and review", description: "Read every change an agent makes beside the conversation, then commit, push, or open a pull request." },
      { slug: "git", title: "Git and worktrees", description: "Work in your checkout or give a thread its own worktree and branch, and see what OpenOrc adds to your repository." },
      { slug: "pull-requests", title: "Pull requests", description: "Browse a project's GitHub pull requests, read their diffs, draft a review, and post it to GitHub." },
    ],
  },
  {
    title: "Context",
    pages: [
      { slug: "memory", title: "Project memory", description: "Keep decisions and lessons from finished work, so the next thread starts with what you already learned." },
      { slug: "instructions", title: "Instructions", description: "The instruction files agents read in your project, and the short brief OpenOrc adds to every run." },
      { slug: "skills", title: "Skills", description: "See the skills your agents can use in each project, and where they come from." },
    ],
  },
  {
    title: "Teams",
    pages: [
      {
        slug: "teams",
        title: "Agent teams",
        label: "Agent teams (Beta)",
        description: "Put several agents in one conversation: a lead that plans and hands out work, and members that report to it. Team execution is in Beta.",
      },
    ],
  },
  {
    title: "Integrations",
    pages: [
      { slug: "slack", title: "Slack", description: "Mention your personal bot in Slack and let an agent on your computer reply in the thread." },
      { slug: "browser", title: "Browser preview", description: "A browser beside the conversation that you and your agents share, for checking web work as it changes." },
      { slug: "terminal", title: "Terminal and processes", description: "A terminal in every thread, and the long-running processes, like dev servers, that agents start." },
    ],
  },
  {
    title: "Reference",
    pages: [
      { slug: "settings", title: "Settings", description: "Every settings section, what it controls, and where its choices are saved." },
      { slug: "shortcuts", title: "Keyboard shortcuts", description: "Move around OpenOrc without leaving the keyboard." },
      { slug: "storage", title: "Data and storage", description: "What OpenOrc stores on your computer, where, for how long, and what deleting removes." },
      { slug: "network", title: "Network connections", description: "Every connection OpenOrc makes, where it goes, what it sends, and which ones you can turn off." },
      { slug: "security", title: "Security model", description: "What stops web pages, other accounts, and other programs from using OpenOrc's access, and what it cannot protect against." },
      { slug: "how-it-works", title: "How OpenOrc works", description: "The processes OpenOrc runs, how it talks to each agent, and the path a message takes from the composer and back." },
      { slug: "troubleshooting", title: "Troubleshooting", description: "Fixes for the problems people run into most, from sign-in to stuck threads." },
      { slug: "known-issues", title: "Known issues", description: "Limitations and bugs we know about in the current version, with what to expect when you run into them." },
    ],
  },
];

export const docPages: DocPage[] = docGroups.flatMap((group) => group.pages);

export const docHref = (slug: string) => (slug ? `/docs/${slug}/` : "/docs/");
export const docLabel = (page: DocPage) => page.label ?? page.title;
export const docPage = (slug: string) => docPages.find((page) => page.slug === slug);
