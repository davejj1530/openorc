import { listEvents, runs as runRepo, summaries, type Db } from "@openorc/db";
import type { Orcling, Run, SessionSummary, Thread } from "@openorc/protocol";

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/** Where an Orcling is speaking, which decides what it is told about the place. */
export type OrclingPlace = "home" | "thread" | "guest" | "elsewhere";

/** Who the Orcling is, its instructions and memory: sent with every process it starts, wherever it works. */
export function orclingBrief(orcling: Orcling, input: { instructions: string; memory: string; place: OrclingPlace; tools: boolean }): string {
  const lines = [
    `# You are ${orcling.name}`,
    `You are ${orcling.name}, an Orcling: the user's long-term companion in OpenOrc. You are the same ${orcling.name} everywhere: in your own conversation with them and wherever they bring you, such as project threads, task comments, teams, pull request reviews and Slack. What you learn in one place stays with you in the others.`,
    placeNote(orcling, input.place),
    "",
    "## Your instructions",
    input.instructions.trim() || "(Empty. Write your own with orcling_instructions_update once you know how this person likes to work.)",
  ];
  if (input.tools) lines.push(...TOOLS);
  if (input.memory) lines.push("", input.memory);
  return lines.join("\n");
}

const TOOLS = [
  "",
  "## Staying yourself",
  "- These instructions are yours. When the person tells you how they want you to be, or you learn something lasting about working together, rewrite them with orcling_instructions_update and say in your reply what you changed.",
  "- orcling_remember saves something lasting about the person to your own memory, and orcling_recall searches it. Project memory is separate: keep facts about a project's code there.",
  "- orcling_history searches what was said in your conversation and wherever else you helped, including sessions that are no longer in your context.",
  "- orcling_projects and orcling_project find the person's Workspace and projects and what is happening in them; what you find there is that place's record, not your own memory. orcling_thread_read reads any thread, orcling_task_create saves a task to a project's backlog, orcling_thread_start starts work in a project where you do it yourself, and orcling_thread_send hands an existing thread work.",
];

function placeNote(orcling: Orcling, place: OrclingPlace): string {
  switch (place) {
    case "home":
      return "This is your own conversation with the person: one thread that never ends, like texting a friend. Code changes belong in project threads: when the person wants work done in a project, start it there with orcling_thread_start rather than editing its files from here.";
    case "guest":
      return `The person mentioned you in a conversation that belongs to another agent. Answer what they asked of you, as ${orcling.name}; the conversation's own agent carries on after you.`;
    case "thread":
      return "The person chose you to work in this conversation. Follow its instructions below as you would any of theirs.";
    case "elsewhere":
      return "The person asked for you here. The rules of this place, below, come first.";
  }
}

function speaker(run: Run, role: "user" | "assistant" | "system", names: (orclingId: string) => string | null): string {
  if (role === "user") return "The person";
  if (role === "system") return "OpenOrc";
  return run.orclingId ? (names(run.orclingId) ?? "An Orcling") : "The agent";
}

/** The newest messages of these runs, oldest first, with who said each one. */
export function recentExchange(db: Db, own: Run[], names: (orclingId: string) => string | null, limit: number): string[] {
  const lines: { ts: number; text: string }[] = [];
  for (const run of own.slice(-8)) {
    for (const event of listEvents(db, run.id, { kinds: ["message.completed"], newest: true, limit: 400 })) {
      if (event.type !== "message.completed" || !event.text.trim()) continue;
      lines.push({ ts: event.ts, text: `${speaker(run, event.role, names)}: ${clip(flat(event.text), event.role === "assistant" ? 1200 : 600)}` });
    }
  }
  return lines
    .sort((a, b) => a.ts - b.ts)
    .slice(-limit)
    .map((line) => line.text);
}

function summaryLine(summary: SessionSummary): string {
  const date = new Date(summary.createdAt).toISOString().slice(0, 10);
  const open = summary.openItems.length ? ` Left open: ${summary.openItems.map(flat).join("; ")}.` : "";
  return `- ${date}: ${clip(flat(summary.request), 200)}. ${clip(flat(summary.workDone || summary.outcome), 400)}${open}`;
}

/** What a fresh session of an Orcling's own conversation starts from: earlier sessions in brief, then where it left off. */
export function rolloverSeed(db: Db, thread: Thread, names: (orclingId: string) => string | null): string {
  const own = runRepo.listForThread(db, thread.id);
  const earlier = summaries.forThread(db, thread.id, 6).reverse();
  const lines = ["Your conversation continues in a new session. Earlier sessions are summarized here; search their full text with orcling_history."];
  if (earlier.length) lines.push("", "## Earlier sessions, most recent last", ...earlier.map(summaryLine));
  const recent = recentExchange(db, own, names, 12);
  if (recent.length) lines.push("", "## Where you left off, most recent last", ...recent);
  return lines.join("\n");
}

/**
 * What others said in a conversation that this speaker has not heard: since
 * its last turn there, or everything when it joins late. The thread's agent
 * hears a guest Orcling's answer, and a guest hears the conversation it was
 * asked into. Empty when nobody else spoke.
 */
export function catchUp(db: Db, thread: Thread, orclingId: string | null, names: (orclingId: string) => string | null): string {
  const all = runRepo.listForThread(db, thread.id);
  const last = all.filter((run) => (run.orclingId ?? null) === orclingId).at(-1);
  const others = all.filter((run) => (run.orclingId ?? null) !== orclingId && (!last || run.startedAt > last.startedAt));
  const exchange = others.length ? recentExchange(db, others, names, last ? 10 : 12) : [];
  if (!exchange.length) return "";
  const heading = last ? "Since your last turn in this conversation, others spoke here, most recent last:" : "This conversation began before you joined. What was said, most recent last:";
  return [heading, ...exchange].join("\n");
}
