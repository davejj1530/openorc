import { ownToolName } from "./tool-presentation.js";
import { toolResult } from "./tool-result.js";
import type { Block } from "./transcript.js";

/**
 * What one of OpenOrc's own tools came back with, read into the thing it is about: threads, a conversation, a
 * page, tasks, memories. The app knows these shapes, so each draws as what it is rather than as data. Any other
 * tool, and any answer that does not have the shape its tool gives, reads as nothing here and draws the general way.
 */

type ToolBlock = Extract<Block, { kind: "tool" }>;

export interface ThreadRow {
  id: string;
  title: string;
  activity: "idle" | "running" | "waiting";
  branch: string | null;
  /** The thread the call was made from. */
  current: boolean;
  lastReply: string | null;
  lastActivityAt: number | null;
}

export interface TaskRow {
  id: string;
  title: string;
  status: string;
  /** The task the call's own run works on. */
  current: boolean;
  /** Where its run stands, when it has one: working, waiting, failed. */
  state: string | null;
  /** The newest thing to say of it: what its agent last said, or what it came to. */
  latest: string | null;
}

export interface MemoryRow {
  type: string;
  title: string;
  summary: string;
  ageDays: number | null;
}

export type OwnToolView =
  | { kind: "threads"; threads: ThreadRow[] }
  | { kind: "thread"; thread: ThreadRow; messages: { role: string; text: string }[] }
  | { kind: "sent"; text: string; delivered: boolean; landed: string }
  | { kind: "page"; url: string; title: string; text: string | null }
  | { kind: "memories"; query: string; hits: MemoryRow[] }
  | { kind: "remembered"; type: string; title: string; body: string }
  | { kind: "tasks"; tasks: TaskRow[] }
  | { kind: "task"; task: TaskRow };

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : null);
const word = (value: unknown): string | null => (typeof value === "string" ? value : null);

function threadRow(value: unknown): ThreadRow | null {
  const thread = fields(value);
  const id = word(thread?.["id"]);
  const title = word(thread?.["title"]);
  if (!thread || !id || title === null) return null;
  const activity = thread["activity"] === "running" || thread["activity"] === "waiting" ? thread["activity"] : "idle";
  const at = thread["lastActivityAt"];
  return { id, title, activity, branch: word(thread["branch"]), current: thread["current"] === true, lastReply: word(thread["lastReply"]), lastActivityAt: typeof at === "number" ? at : null };
}

function taskRow(value: unknown): TaskRow | null {
  const task = fields(value);
  const id = word(task?.["id"]);
  const title = word(task?.["title"]);
  if (!task || !id || title === null) return null;
  const activity = fields(task["activity"]);
  return {
    id,
    title,
    status: word(task["status"]) ?? "",
    current: task["current"] === true,
    state: word(activity?.["state"]),
    latest: word(activity?.["latestMessage"]) ?? word(task["resultSummary"]),
  };
}

function memoryRow(value: unknown): MemoryRow | null {
  const hit = fields(value);
  const title = word(hit?.["title"]);
  if (!hit || title === null) return null;
  return { type: word(hit["type"]) ?? "", title, summary: word(hit["summary"]) ?? "", ageDays: typeof hit["ageDays"] === "number" ? hit["ageDays"] : null };
}

/** A list read whole: every item must be the thing the tool lists, or the answer is not this tool's. */
function rows<T>(value: unknown, read: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.map(read);
  return items.every((item) => item !== null) ? (items as T[]) : null;
}

function threads(said: unknown): OwnToolView | null {
  const listed = rows(said, threadRow);
  return listed ? { kind: "threads", threads: listed } : null;
}

function tasks(said: unknown): OwnToolView | null {
  const listed = rows(said, taskRow);
  return listed ? { kind: "tasks", tasks: listed } : null;
}

function task(said: unknown): OwnToolView | null {
  const one = taskRow(said);
  return one ? { kind: "task", task: one } : null;
}

function memories(said: unknown, input: Fields): OwnToolView | null {
  const hits = rows(said, memoryRow);
  return hits ? { kind: "memories", query: word(input["query"]) ?? "", hits } : null;
}

function conversation(said: unknown): OwnToolView | null {
  const read = fields(said);
  const thread = threadRow(read?.["thread"]);
  const messages = rows(read?.["messages"], (item) => {
    const message = fields(item);
    const text = word(message?.["text"]);
    return message && text !== null ? { role: word(message["role"]) ?? "assistant", text } : null;
  });
  return thread && messages ? { kind: "thread", thread, messages } : null;
}

function sent(said: unknown, input: Fields): OwnToolView | null {
  const landed = fields(said);
  const text = word(input["text"]) ?? word(input["message"]);
  if (!landed || text === null || typeof landed["delivered"] !== "boolean") return null;
  return { kind: "sent", text, delivered: landed["delivered"], landed: word(landed["message"]) ?? "" };
}

function page(said: unknown): OwnToolView | null {
  const shown = fields(said);
  const url = word(shown?.["url"]);
  if (!shown || url === null) return null;
  // A page with no title of its own is titled by its address, which says nothing more.
  const title = word(shown["title"]) ?? "";
  return { kind: "page", url, title: url.includes(title) ? "" : title, text: word(fields(shown["snapshot"])?.["text"])?.trim() || null };
}

function remembered(said: unknown, input: Fields): OwnToolView | null {
  const title = word(input["title"]);
  if (fields(said)?.["recorded"] !== true || title === null) return null;
  return { kind: "remembered", type: word(input["type"]) ?? "", title, body: word(input["body"]) ?? "" };
}

/** Each of OpenOrc's tools the app draws as its own thing, by the tool's name, with what reads its answer. */
const readers: [RegExp, (said: unknown, input: Fields) => OwnToolView | null][] = [
  [/^thread_list$/, threads],
  [/^thread_read$/, conversation],
  [/(?:^|_)(?:thread_send|send_message|team_say)$/, sent],
  [/^browser$/, page],
  [/^memory_search$/, memories],
  [/^memory_record$/, remembered],
  [/^task_list$/, tasks],
  [/^task_(?:get|update)$/, task],
];

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The data a tool answered with: the first part of its answer that is data. An agent may add words of its own
 * after it, such as where it kept a picture, so the answer is read part by part before it is read whole.
 */
function answered(output: unknown): unknown {
  const parts = Array.isArray(output) ? output : fields(output)?.["content"];
  const texts = Array.isArray(parts) ? parts.flatMap((part) => (fields(part)?.["type"] === "text" ? [word(fields(part)?.["text"]) ?? ""] : [])) : [];
  for (const text of [...texts, toolResult(output).text]) {
    const data = parsed(text);
    if (data !== undefined) return data;
  }
  return undefined;
}

const known = new WeakMap<ToolBlock, OwnToolView | null>();

function read(block: ToolBlock, output: unknown): OwnToolView | null {
  const name = ownToolName(block.name);
  const reader = name ? readers.find(([pattern]) => pattern.test(name))?.[1] : undefined;
  if (!reader || block.isError || output === undefined || output === null) return null;
  const said = answered(output);
  return said === undefined ? null : reader(said, fields(block.input) ?? {});
}

/**
 * The call as the thing it is about, or null for a call that is not one of these or has no answer yet. `output` is
 * the answer when the block does not carry it, as on a page that left large answers out.
 */
export function ownToolView(block: ToolBlock, output: unknown = block.output): OwnToolView | null {
  if (output !== block.output) return read(block, output);
  if (!known.has(block)) known.set(block, read(block, output));
  return known.get(block) ?? null;
}

const counted = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/** What a call's line adds once its answer is read: the thing it was about by name, and what it came to. */
export function ownToolLine(view: OwnToolView): { name?: string; result?: string } {
  switch (view.kind) {
    case "threads":
      return { result: counted(view.threads.length, "thread") };
    case "thread":
      return { name: view.thread.title, result: `last ${counted(view.messages.length, "message")}` };
    case "sent":
      return view.delivered ? {} : { result: "Not delivered" };
    case "page":
      return view.title ? { result: view.title } : {};
    case "memories":
      return { result: view.hits.length ? `${view.hits.length} found` : "Nothing found" };
    case "tasks":
      return { result: counted(view.tasks.length, "task") };
    case "task":
      return { name: view.task.title, result: view.task.status };
    case "remembered":
      return {};
  }
}

/* ------------------------------------------------------------------ Words both apps draw these with */

/** A reply as one plain line: its marks for emphasis and code are for a reader of the whole. */
export const oneLine = (text: string): string =>
  text
    .replace(/\*\*|__|`/g, "")
    .replace(/^[#>\s]+/, "")
    .replace(/\s+/g, " ");

/** Words past this many lines or letters read by their start until asked for. */
const FOLD = { lines: 4, letters: 320 };
export const foldsWords = (text: string): boolean => text.length > FOLD.letters || text.split("\n").length > FOLD.lines;

const KINDS: Record<string, string> = { decision: "a decision", lesson: "a lesson", command: "a command that works", env_quirk: "an environment quirk", convention: "a convention", spec: "a spec" };
/** A memory's kind in plain words: "a lesson", "an environment quirk". Null for a kind with no words. */
export const memoryKind = (type: string): string | null => KINDS[type] ?? null;

/** How old a memory is, when it says. */
export function memoryAge(days: number | null): string {
  if (days === null) return "";
  return days < 1 ? "today" : `${Math.round(days)}d ago`;
}

const TASK_STATES: Record<string, string> = { working: "Working", waiting: "Waiting", failed: "Failed", cancelled: "Stopped", completed: "Done" };
/** Where a task's run stands, in a word; empty when it has none. */
export const taskState = (state: string | null): string => (state ? (TASK_STATES[state] ?? "") : "");

/** Another thread's note names its thread: `Message from the thread "Title" (id …):`, then what it said. */
const FROM_THREAD = /^Message from the thread "(.+?)" \(id ([0-9a-f-]{36})\):\s*/;
export function fromThread(text: string): { title: string; id: string; text: string } | null {
  const from = FROM_THREAD.exec(text);
  return from ? { title: from[1]!, id: from[2]!, text: text.slice(from[0].length) } : null;
}
