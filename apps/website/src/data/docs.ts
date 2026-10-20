export interface DocPage {
  slug: string;
  title: string;
  /** Shorter name for navigation, when the page title is written as a heading. */
  label?: string;
  description: string;
  /** The page's h2 sections, for the outline beside it and for search. */
  sections: DocSection[];
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
        sections: [
          { id: "start-here", title: "Start here" },
          { id: "what-you-can-do", title: "What you can do" },
          { id: "more-resources", title: "More resources" },
        ],
      },
      {
        slug: "quickstart",
        title: "Quickstart",
        description: "Install OpenOrc, add a project, and finish your first change in a few minutes.",
        sections: [
          { id: "install", title: "Install OpenOrc" },
          { id: "agent", title: "Set up an agent" },
          { id: "setup", title: "Finish setup" },
          { id: "first-thread", title: "Start your first thread" },
          { id: "review", title: "Review and commit" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
      {
        slug: "concepts",
        title: "Core concepts",
        description: "Projects, threads, turns, tasks, and the other ideas the rest of these pages build on.",
        sections: [
          { id: "where", title: "Where agents work" },
          { id: "conversations", title: "Conversations" },
          { id: "planning", title: "Planning and context" },
          { id: "companions", title: "Orclings and teams" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
    ],
  },
  {
    title: "Threads",
    pages: [
      {
        slug: "threads",
        title: "Threads",
        description: "A thread is a conversation with a coding agent about your code. Start one, steer it while it works, and pick it up later.",
        sections: [
          { id: "start", title: "Start a thread" },
          { id: "composer", title: "Write a message" },
          { id: "while-working", title: "Send while the agent works" },
          { id: "stop", title: "Stop a turn" },
          { id: "fork", title: "Fork a thread" },
          { id: "side-by-side", title: "Open threads side by side" },
          { id: "sidebar", title: "The sidebar" },
          { id: "import", title: "Import terminal sessions" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
      {
        slug: "agents",
        title: "Agents and models",
        description: "Choose Codex, Claude Code, or OpenCode for each thread, then the model and effort that fit the job.",
        sections: [
          { id: "supported", title: "Supported agents" },
          { id: "differences", title: "How they differ" },
          { id: "finding", title: "How OpenOrc finds them" },
          { id: "choose", title: "Choose the agent and model" },
          { id: "effort", title: "Effort and Fast mode" },
          { id: "switch", title: "Switch agents in a thread" },
          { id: "usage", title: "Usage and allowances" },
          { id: "updates", title: "Update the agents" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
      {
        slug: "permissions",
        title: "Modes and permissions",
        description: "Decide how much an agent may do on its own, from planning only to editing and running commands.",
        sections: [
          { id: "choose-a-mode", title: "Choose a mode" },
          { id: "what-each-mode-allows", title: "What each mode allows" },
          { id: "plan", title: "Plan, then implement" },
          { id: "approvals", title: "Answer an approval" },
          { id: "openorc-tools", title: "OpenOrc's tools" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
      {
        slug: "work",
        title: "Following the work",
        description: "Read what an agent is doing while it works, see what it changed, and undo a turn.",
        sections: [
          { id: "while-it-works", title: "While the agent works" },
          { id: "open-a-step", title: "Open a step" },
          { id: "when-it-finishes", title: "When a turn finishes" },
          { id: "changes", title: "Review or undo a turn" },
          { id: "questions-and-approvals", title: "Questions and approvals" },
          { id: "inbox", title: "The Inbox" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
      {
        slug: "messaging",
        title: "Threads working together",
        description: "Let threads message each other and start helper threads, so separate pieces of work stay in step.",
        sections: [
          { id: "how-it-works", title: "How it works" },
          { id: "ask", title: "Ask in plain words" },
          { id: "helper-threads", title: "Helper threads" },
          { id: "messages", title: "Messages between threads" },
          { id: "limits", title: "How exchanges end" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
      {
        slug: "orclings",
        title: "Orclings",
        description: "Companions you design, each with its own conversation, instructions, and private memory. Think something through with one, or bring it into project work.",
        sections: [
          { id: "create", title: "Create an Orcling" },
          { id: "own-conversation", title: "Its own conversation" },
          { id: "what-it-sees", title: "What it sees" },
          { id: "instructions-and-memory", title: "Instructions and memory" },
          { id: "project-work", title: "Bring it into project work" },
          { id: "edit-or-delete", title: "Edit or delete an Orcling" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
    ],
  },
  {
    title: "Tasks",
    pages: [
      {
        slug: "tasks",
        title: "Tasks",
        description: "Plan work as tasks with a status, a priority, and a written spec, then start them when you are ready.",
        sections: [
          { id: "how-tasks-work", title: "How tasks work" },
          { id: "create", title: "Create a task" },
          { id: "spec", title: "Write the spec" },
          { id: "status", title: "Status and priority" },
          { id: "tabs", title: "The task's tabs" },
          { id: "start", title: "Start a task" },
          { id: "list", title: "The Tasks list" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
      {
        slug: "discussions",
        title: "Task discussions",
        description: "Ask one or more models about a task before anyone builds it, then hand the work to a thread.",
        sections: [
          { id: "how-it-works", title: "How discussions work" },
          { id: "ask", title: "Ask a model" },
          { id: "replies", title: "How replies arrive" },
          { id: "several", title: "Ask several models" },
          { id: "work", title: "From discussion to work" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
      {
        slug: "schedules",
        title: "Schedules",
        description: "Run a prompt on a project on a timer, from every 30 minutes to once a week, while OpenOrc is open.",
        sections: [
          { id: "how-it-works", title: "How schedules work" },
          { id: "create", title: "Create a schedule" },
          { id: "results", title: "Where results go" },
          { id: "manage", title: "Pause, run now and delete" },
          { id: "timing", title: "When a schedule runs" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
    ],
  },
  {
    title: "Code and review",
    pages: [
      {
        slug: "review",
        title: "Changes and review",
        description: "Read every change an agent makes beside the conversation, then commit, push, or open a pull request.",
        sections: [
          { id: "changes-panel", title: "The Changes panel" },
          { id: "turn", title: "Review one turn" },
          { id: "comments", title: "Comment on lines" },
          { id: "commit", title: "Commit" },
          { id: "push", title: "Push and open a pull request" },
          { id: "tasks", title: "Changes in a task" },
          { id: "requirements", title: "What each action needs" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
      {
        slug: "git",
        title: "Git and worktrees",
        description: "Work in your checkout or give a thread its own worktree and branch, and see what OpenOrc adds to your repository.",
        sections: [
          { id: "where", title: "Checkout or worktree" },
          { id: "choose", title: "Choose for each thread" },
          { id: "worktrees", title: "How a worktree is made" },
          { id: "move", title: "Move a thread" },
          { id: "merge", title: "Bring the work back" },
          { id: "delete", title: "Delete a thread" },
          { id: "repository", title: "What OpenOrc adds to your repository" },
          { id: "no-git", title: "Projects without Git" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
      {
        slug: "pull-requests",
        title: "Pull requests",
        description: "Browse a project's GitHub pull requests, read their diffs, draft a review, and post it to GitHub.",
        sections: [
          { id: "open", title: "Open pull requests" },
          { id: "browse", title: "Browse and filter" },
          { id: "read", title: "Read a pull request" },
          { id: "draft", title: "Draft a review" },
          { id: "model", title: "Let a model review" },
          { id: "submit", title: "Submit the review" },
          { id: "requirements", title: "What it needs" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
    ],
  },
  {
    title: "Context",
    pages: [
      {
        slug: "memory",
        title: "Project memory",
        description: "Keep decisions and lessons from finished work, so the next thread starts with what you already learned.",
        sections: [
          { id: "what", title: "What a memory is" },
          { id: "turn-on", title: "Turn memory on" },
          { id: "made", title: "How memories are made" },
          { id: "review", title: "Review and edit memories" },
          { id: "later-runs", title: "How later runs use memory" },
          { id: "models", title: "Choose who summarizes runs" },
          { id: "privacy", title: "What leaves your computer" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
      {
        slug: "instructions",
        title: "Instructions",
        description: "The instruction files agents read in your project, and the short brief OpenOrc adds to every run.",
        sections: [
          { id: "files", title: "Instruction files" },
          { id: "loading", title: "How each agent loads them" },
          { id: "edit", title: "Edit them in OpenOrc" },
          { id: "brief", title: "The brief OpenOrc adds" },
          { id: "delivery", title: "How the brief reaches the agent" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
      {
        slug: "skills",
        title: "Skills",
        description: "See the skills your agents can use in each project, and where they come from.",
        sections: [
          { id: "what", title: "What a skill is" },
          { id: "browse", title: "Browse skills" },
          { id: "sources", title: "Where skills come from" },
          { id: "use", title: "Use a skill in a conversation" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
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
        sections: [
          { id: "what-a-team-is", title: "What a team is" },
          { id: "turn-on", title: "Turn on team execution" },
          { id: "create", title: "Create a team" },
          { id: "start", title: "Start a team conversation" },
          { id: "talk", title: "Talk to the team" },
          { id: "members", title: "How members work together" },
          { id: "changes", title: "Review and combine changes" },
          { id: "needs-you", title: "When the team needs you" },
          { id: "limits", title: "Limits" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
    ],
  },
  {
    title: "Integrations",
    pages: [
      {
        slug: "slack",
        title: "Slack",
        description: "Mention your personal bot in Slack and let an agent on your computer reply in the thread.",
        sections: [
          { id: "how", title: "How it works" },
          { id: "connect", title: "Connect your bot" },
          { id: "mention", title: "Mention your bot" },
          { id: "in-slack", title: "What you see in Slack" },
          { id: "approvals", title: "Approve from Slack" },
          { id: "desktop", title: "Find the conversation in OpenOrc" },
          { id: "limits", title: "Limits" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
      {
        slug: "browser",
        title: "Browser preview",
        description: "A browser beside the conversation that you and your agents share, for checking web work as it changes.",
        sections: [
          { id: "open", title: "Open the Preview" },
          { id: "agents", title: "How agents use it" },
          { id: "approval", title: "What needs approval" },
          { id: "sign-ins", title: "Sign-ins" },
          { id: "limits", title: "Limits" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
      {
        slug: "terminal",
        title: "Terminal and processes",
        description: "A terminal in every thread, and the long-running processes, like dev servers, that agents start.",
        sections: [
          { id: "open", title: "Open a terminal" },
          { id: "shell", title: "Shell and folder" },
          { id: "lifetime", title: "How long a shell runs" },
          { id: "processes", title: "Processes agents start" },
          { id: "finishing", title: "When the turn ends" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
    ],
  },
  {
    title: "Reference",
    pages: [
      {
        slug: "settings",
        title: "Settings",
        description: "Every settings section, what it controls, and where its choices are saved.",
        sections: [
          { id: "usage", title: "Usage" },
          { id: "connections", title: "Connections" },
          { id: "slack", title: "Slack" },
          { id: "skills", title: "Skills" },
          { id: "appearance", title: "Appearance" },
          { id: "general", title: "General" },
          { id: "memory", title: "Memory & models" },
          { id: "data", title: "Data" },
          { id: "saved", title: "Where settings are saved" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
      {
        slug: "shortcuts",
        title: "Keyboard shortcuts",
        description: "Move around OpenOrc without leaving the keyboard.",
        sections: [
          { id: "navigation", title: "Navigation" },
          { id: "threads", title: "Threads" },
          { id: "composer", title: "Composer" },
          { id: "tasks", title: "Tasks list and task pages" },
          { id: "review", title: "Review and editing" },
          { id: "layout", title: "Resizing and menus" },
          { id: "app-menu", title: "App menu" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
      {
        slug: "storage",
        title: "Data and storage",
        description: "What OpenOrc stores on your computer, where, for how long, and what deleting removes.",
        sections: [
          { id: "data-folder", title: "The data folder" },
          { id: "outside", title: "Outside the data folder" },
          { id: "database", title: "The database" },
          { id: "ledger", title: "Agent events" },
          { id: "redaction", title: "Redaction" },
          { id: "secrets", title: "Settings and secrets" },
          { id: "window", title: "Window storage" },
          { id: "retention", title: "How long things stay" },
          { id: "deleting", title: "What deleting removes" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
      {
        slug: "network",
        title: "Network connections",
        description: "Every connection OpenOrc makes, where it goes, what it sends, and which ones you can turn off.",
        sections: [
          { id: "summary", title: "Every connection" },
          { id: "agents", title: "Agents" },
          { id: "background", title: "Background requests" },
          { id: "downloads", title: "Downloads and update checks" },
          { id: "git", title: "Git and GitHub" },
          { id: "local", title: "Local servers" },
          { id: "never", title: "What OpenOrc does not send" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
      {
        slug: "security",
        title: "Security model",
        description: "What stops web pages, other accounts, and other programs from using OpenOrc's access, and what it cannot protect against.",
        sections: [
          { id: "scope", title: "What this covers" },
          { id: "servers", title: "Local servers" },
          { id: "window", title: "The app window and the Preview" },
          { id: "agents", title: "What agents can do through OpenOrc" },
          { id: "package", title: "The installed app" },
          { id: "secrets", title: "Secrets and your data" },
          { id: "limits", title: "What OpenOrc cannot protect against" },
          { id: "report", title: "Reporting a vulnerability" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
      {
        slug: "how-it-works",
        title: "How OpenOrc works",
        description: "The processes OpenOrc runs, how it talks to each agent, and the path a message takes from the composer and back.",
        sections: [
          { id: "parts", title: "The parts" },
          { id: "processes", title: "Every process" },
          { id: "interface", title: "How the interface talks to the core" },
          { id: "agents", title: "How OpenOrc runs each agent" },
          { id: "message", title: "The path a message takes" },
          { id: "runs", title: "Runs, turns, and sessions" },
          { id: "lifecycle", title: "Startup, shutdown, and recovery" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
      {
        slug: "troubleshooting",
        title: "Troubleshooting",
        description: "Fixes for the problems people run into most, from sign-in to stuck threads.",
        sections: [
          { id: "agent", title: "An agent is missing or signed out" },
          { id: "stuck", title: "A thread seems stuck" },
          { id: "approvals", title: "Approvals don't appear" },
          { id: "slack", title: "Slack doesn't reply" },
          { id: "git", title: "Worktree and Git errors" },
          { id: "updates", title: "Updates won't install" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
      {
        slug: "known-issues",
        title: "Known issues",
        description: "Limitations and bugs we know about in the current version, with what to expect when you run into them.",
        sections: [
          { id: "windows", title: "More than one window" },
          { id: "restarts", title: "Crashes and restarts" },
          { id: "threads", title: "Threads" },
          { id: "git", title: "Tasks and Git" },
          { id: "storage", title: "Storage" },
          { id: "memory", title: "Memory" },
          { id: "slack", title: "Slack" },
          { id: "teams", title: "Agent teams (Beta)" },
          { id: "windows-os", title: "Windows" },
          { id: "linux", title: "Linux" },
          { id: "next-steps", title: "Next steps" },
        ],
      },
    ],
  },
];

export const docPages: DocPage[] = docGroups.flatMap((group) => group.pages);

export const docHref = (slug: string) => (slug ? `/docs/${slug}/` : "/docs/");
export const docLabel = (page: DocPage) => page.label ?? page.title;
export const docPage = (slug: string) => docPages.find((page) => page.slug === slug);
