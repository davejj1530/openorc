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
      "Yes. OpenOrc works with the Codex, Claude Code, and OpenCode tools you already have installed, through their own sign-in and configuration. Provider subscriptions and API usage stay separate.",
  },
  {
    id: "where-work-lives",
    question: "Where does my work live?",
    answer:
      "Projects, conversation history, tasks, and project memory are stored on your computer. Each agent’s requests go to that agent’s provider, under its data policies. So do conversation titles, and run summaries once you turn memory on, unless you choose another provider in settings.",
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
    id: "while-closed",
    question: "Does scheduled or Slack work run while OpenOrc is closed?",
    answer: "No. Agents run on your computer. Keep OpenOrc open and your computer awake for scheduled work and Slack replies.",
  },
];
