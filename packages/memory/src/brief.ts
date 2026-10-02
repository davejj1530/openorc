import { memories, summaries, type Db } from "@openorc/db";
import type { Memory, MemorySource, MemoryType } from "@openorc/protocol";

const MAX_CHARS = 5000;
const HALF_LIFE_MS = 90 * 24 * 60 * 60 * 1000;

const SECTIONS: { type: MemoryType; heading: string; max: number }[] = [
  { type: "decision", heading: "Decisions", max: 6 },
  { type: "lesson", heading: "Lessons (what failed and why)", max: 8 },
  { type: "command", heading: "Commands that work", max: 6 },
  { type: "env_quirk", heading: "Environment quirks", max: 4 },
  { type: "convention", heading: "Conventions", max: 5 },
  { type: "preference", heading: "Preferences", max: 5 },
];

const SOURCE_LABEL: Record<MemorySource, string> = { user: "from the user", agent: "saved by an agent", tool: "saved by a tool", extraction: "from a run summary" };

const AGE_LABEL = (ts: number): string => {
  const d = Math.round((Date.now() - ts) / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  return `${Math.round(d / 30)}mo ago`;
};

/**
 * The compact brief injected into every run's system prompt: the project's
 * durable memory plus open threads, capped so it never crowds the context.
 * Ranked within each section by confidence and recency.
 */
export function buildBrief(db: Db, projectId: string, openTaskTitles: string[]): string {
  const all = memories.list(db, { projectId, statuses: ["active"], limit: 400 });
  const byType = new Map<MemoryType, Memory[]>();
  for (const m of all) {
    const list = byType.get(m.type) ?? [];
    list.push(m);
    byType.set(m.type, list);
  }
  const score = (m: Memory) => m.confidence * Math.pow(0.5, (Date.now() - m.lastConfirmedAt) / HALF_LIFE_MS);

  const lines: string[] = [];
  lines.push("# Project memory", "Durable facts from earlier runs on this project. Trust but verify; each line shows its age and who saved it.");

  for (const section of SECTIONS) {
    const items = (byType.get(section.type) ?? []).sort((a, b) => score(b) - score(a)).slice(0, section.max);
    if (items.length === 0) continue;
    lines.push("", `## ${section.heading}`);
    for (const m of items) lines.push(`- ${m.title} (${AGE_LABEL(m.lastConfirmedAt)}, ${SOURCE_LABEL[m.source]}): ${m.body}`);
  }

  const recentOpen = summaries
    .recent(db, projectId, 5)
    .flatMap((s) => s.openItems)
    .slice(0, 6);
  if (openTaskTitles.length > 0 || recentOpen.length > 0) {
    lines.push("", "## Open threads");
    for (const t of openTaskTitles.slice(0, 8)) lines.push(`- Task in progress: ${t}`);
    for (const o of recentOpen) lines.push(`- Left open last time: ${o}`);
  }

  lines.push(
    "",
    "## Using memory",
    "Before changing an unfamiliar area, call task_context or memory_search. After a failed approach, call memory_record with type=lesson so the next run does not repeat it.",
  );

  const brief = lines.join("\n");
  return brief.length > MAX_CHARS ? brief.slice(0, MAX_CHARS) + "\n…" : brief;
}

/** Whether there is any memory worth injecting, so empty projects add nothing. */
export function hasBrief(db: Db, projectId: string): boolean {
  return memories.list(db, { projectId, statuses: ["active"], limit: 1 }).length > 0;
}

const ORCLING_SECTIONS: { types: MemoryType[]; heading: string; max: number }[] = [
  { types: ["preference"], heading: "How they like things", max: 8 },
  { types: ["decision"], heading: "Decisions", max: 6 },
  { types: ["lesson", "env_quirk"], heading: "Lessons", max: 6 },
  { types: ["convention", "ownership", "spec", "command"], heading: "Things to know", max: 8 },
];

/** An Orcling's own memory for its prompt: what it has learned about the person it helps, wherever it is working. */
export function buildOrclingBrief(db: Db, orclingId: string): string {
  const all = memories.list(db, { orclingId, statuses: ["active"], limit: 400 });
  if (all.length === 0) return "";
  const score = (m: Memory) => m.confidence * Math.pow(0.5, (Date.now() - m.lastConfirmedAt) / HALF_LIFE_MS);
  const lines = ["# Your memory", "What you have learned about the person you help, from every conversation. It is yours alone. Each line shows its age."];
  for (const section of ORCLING_SECTIONS) {
    const items = all
      .filter((m) => section.types.includes(m.type))
      .sort((a, b) => score(b) - score(a))
      .slice(0, section.max);
    if (items.length === 0) continue;
    lines.push("", `## ${section.heading}`);
    for (const m of items) lines.push(`- ${m.title} (${AGE_LABEL(m.lastConfirmedAt)}): ${m.body}`);
  }
  const brief = lines.join("\n");
  return brief.length > MAX_CHARS ? brief.slice(0, MAX_CHARS) + "\n…" : brief;
}
