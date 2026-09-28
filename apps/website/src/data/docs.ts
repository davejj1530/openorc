export interface DocPage {
  slug: string;
  title: string;
  /** Shorter name for navigation, when the page title is written as a heading. */
  label?: string;
  description: string;
}

export interface DocSection {
  id: string;
  title: string;
}

/** When these pages were last checked against the source. Update it when a page is revised. */
export const docsReviewed = { date: "September 27, 2026" };

export const docPages: DocPage[] = [
  {
    slug: "",
    title: "How OpenOrc works",
    label: "Overview",
    description:
      "OpenOrc is a desktop app that runs the coding agents you already have and keeps a local record of their work. These pages explain how it is built, from the processes it starts to the rows it writes.",
  },
  {
    slug: "processes",
    title: "Processes and messaging",
    description: "The processes OpenOrc runs, how the interface talks to the core, and what happens at startup and shutdown.",
  },
  {
    slug: "providers",
    title: "Agent providers",
    description: "How OpenOrc starts Claude Code, Codex, and OpenCode, talks to them, and turns their output into one event format.",
  },
  {
    slug: "conversations",
    title: "Conversations, tasks, and runs",
    description: "The records OpenOrc keeps for your work and the path a message takes from the composer to an agent and back.",
  },
  {
    slug: "instructions",
    title: "What OpenOrc tells agents",
    description: "The exact text OpenOrc adds to agent prompts, where it goes for each provider, and the messages it writes on your behalf.",
  },
  {
    slug: "permissions",
    title: "Permissions and app tools",
    description: "What each mode lets agents do, how approvals work, and the rules for OpenOrc's own tools: the browser, messages between conversations, and memory.",
  },
  {
    slug: "storage",
    title: "Local storage",
    description: "What OpenOrc stores on your computer, in which files and tables, how long it keeps it, and what deleting removes.",
  },
  {
    slug: "network",
    title: "Network connections",
    description: "Every connection OpenOrc makes, where it goes, what it sends, and how to turn it off.",
  },
  {
    slug: "security",
    title: "Security model",
    description: "What stops web pages, other accounts, and other programs from using OpenOrc's access, and what it cannot protect against.",
  },
  {
    slug: "memory",
    title: "Project memory",
    description: "How OpenOrc turns finished runs into short project facts, stores and ranks them, and gives them to later runs.",
  },
  {
    slug: "git",
    title: "Git and review",
    description: "How OpenOrc runs Git, creates worktrees, shows changes, applies work to your checkout, and publishes commits and pull requests.",
  },
  {
    slug: "teams",
    title: "Agent teams",
    description: "How agent teams (Beta) schedule several agents, routes their messages, and combines their changes.",
  },
  {
    slug: "slack",
    title: "Slack",
    description: "How a Slack mention becomes a conversation on your computer, who can do what, and what OpenOrc posts back.",
  },
  {
    slug: "known-issues",
    title: "Known issues",
    description: "Limitations and bugs we know about in the current version, with what to expect when you run into them.",
  },
];

export const docHref = (slug: string) => (slug ? `/docs/${slug}/` : "/docs/");
export const docLabel = (page: DocPage) => page.label ?? page.title;
