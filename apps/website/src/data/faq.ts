export interface Question {
  /** The question's place on the homepage, as /#id. */
  id: string;
  question: string;
  answer: string;
}

/** The homepage's questions, in the order it lists them. */
export const questions: Question[] = [
  {
    id: "what-is-openorc",
    question: "What is OpenOrc?",
    answer: "A desktop workspace for coding agents. Conversations, tasks, project context, and code review stay together across your projects.",
  },
  {
    id: "existing-agents",
    question: "Can I use my existing agents?",
    answer:
      "Yes. OpenOrc works with the Codex, Claude Code, OpenCode, Oh My Pi, Cursor, Pi, Antigravity, and fx tools you already have installed, through their own sign-in and configuration. Provider subscriptions and API usage stay separate.",
  },
  {
    id: "where-work-lives",
    question: "Where does my work live?",
    answer:
      "Projects, conversation history, tasks, and project memory are stored on your computer. Each agent’s requests go to that agent’s provider, under its data policies. So do conversation titles, the code explanations you ask for, and run summaries once you turn memory on, unless you choose another provider in settings.",
  },
  {
    id: "saving-a-task",
    question: "Does saving a task start work?",
    answer: "No. A task waits in the backlog until you start it. Discuss it first, then begin when the approach is settled.",
  },
  {
    id: "review-before-shipping",
    question: "Can I review changes before they ship?",
    answer: "Yes. The Changes panel sits beside the conversation. Read the diff, ask for another pass in the thread, then commit, push, or open a pull request when your Git setup supports it.",
  },
  {
    id: "phone",
    question: "Can I use OpenOrc from my phone?",
    answer:
      "Yes. OpenOrc for iPhone pairs with OpenOrc on your computer and connects to it directly, over your network or Tailscale, encrypted end to end. Follow and answer threads, start new ones, and ship their changes. The agents still run on your computer, unless you run a thread in the cloud.",
  },
  {
    id: "while-closed",
    question: "Does scheduled or Slack work run while OpenOrc is closed?",
    answer: "No. Schedules and Slack run on your computer, so keep OpenOrc open and your computer awake for them. The phone app needs your computer too, unless it reaches a cloud brain.",
  },
  {
    id: "cloud",
    question: "Can agents keep working while my computer sleeps?",
    answer:
      "Yes, with Codex, Claude Code, OpenCode, or Oh My Pi in a cloud thread. Cursor, Pi, Antigravity, and fx run on your connected computer. A cloud thread runs in a sandbox on your own Vercel or Agent37 account, which bills you for it, and its changes sync back to a worktree on your computer. Set up the cloud brain too, and your phone can follow and start cloud threads while the computer sleeps.",
  },
];
