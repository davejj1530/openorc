import { describe, expect, it } from "vitest";
import { noticeFrom, ownToolLine, ownToolView } from "./own-tools.js";
import type { Block } from "./transcript.js";
import { workObjects } from "./work-objects.js";
import { objectOutcome } from "./work-outcomes.js";

type ToolBlock = Extract<Block, { kind: "tool" }>;
const call = (name: string, input: unknown, output: unknown, extra: Partial<ToolBlock> = {}): ToolBlock => ({ id: "t", kind: "tool", name, input, output, done: true, isError: false, ...extra });
/** An answer as MCP gives it: its data as text. */
const said = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const thread = { id: "t1", title: "Cloud threads", activity: "running", branch: "cloud", current: false, lastReply: "Half done.", lastActivityAt: 1000 };

describe("ownToolView", () => {
  it("reads a thread list as threads, in every agent's naming of OpenOrc's server", () => {
    const server = `openorc_${"a".repeat(32)}`;
    for (const name of ["openorc.thread_list", `mcp__${server}__thread_list`, `${server}_thread_list`]) {
      expect(ownToolView(call(name, {}, said([thread, { ...thread, id: "t2", activity: "idle", branch: null, lastReply: null }])))).toEqual({
        kind: "threads",
        threads: [
          { ...thread, activity: "running" },
          { id: "t2", title: "Cloud threads", activity: "idle", branch: null, current: false, lastReply: null, lastActivityAt: 1000 },
        ],
      });
    }
  });

  it("reads a thread that was read as its messages, and a message that was sent as what it said and how it landed", () => {
    expect(ownToolView(call("openorc.thread_read", { id: "t1" }, said({ thread, messages: [{ role: "assistant", text: "Done." }] })))).toEqual({
      kind: "thread",
      thread,
      messages: [{ role: "assistant", text: "Done." }],
    });
    expect(ownToolView(call("openorc.thread_send", { id: "t1", text: "One question." }, said({ delivered: true, message: "Delivered to the running turn." })))).toEqual({
      kind: "sent",
      text: "One question.",
      delivered: true,
      landed: "Delivered to the running turn.",
    });
  });

  it("reads the page the browser was on past what an agent adds after it, and drops a title that is only the address", () => {
    const shot = [
      { type: "text", text: JSON.stringify({ url: "http://localhost:4321/pricing", title: "Pricing" }) },
      { type: "image", data: "cG5n", mimeType: "image/png" },
      { type: "text", text: "[Image: source: /tmp/shot.png]" },
    ];
    expect(ownToolView(call("openorc.browser", { action: "screenshot" }, shot))).toEqual({ kind: "page", url: "http://localhost:4321/pricing", title: "Pricing", text: null });
    const opened = said({ url: "http://127.0.0.1:5393/light.html", title: "127.0.0.1:5393/light.html", snapshot: { text: " Live\nFinished ", elements: [] } });
    expect(ownToolView(call("openorc.browser", { action: "open", url: "http://127.0.0.1:5393/light.html" }, opened))).toEqual({
      kind: "page",
      url: "http://127.0.0.1:5393/light.html",
      title: "",
      text: "Live\nFinished",
    });
  });

  it("reads tasks and memories as rows, and a memory it kept as what it kept", () => {
    const task = {
      id: "k1",
      title: "Ship it",
      status: "in_progress",
      branch: null,
      current: true,
      resultSummary: null,
      activity: { runId: "r", state: "working", latestMessage: "Writing tests", lastAction: null, waitingFor: null, updatedAt: 1 },
    };
    expect(ownToolView(call("openorc.task_list", {}, said([task])))).toEqual({
      kind: "tasks",
      tasks: [{ id: "k1", title: "Ship it", status: "in_progress", current: true, state: "working", latest: "Writing tests" }],
    });
    expect(ownToolView(call("openorc.task_get", { id: "k1" }, said({ ...task, activity: null, resultSummary: "Shipped." })))).toMatchObject({
      kind: "task",
      task: { state: null, latest: "Shipped." },
    });
    expect(ownToolView(call("openorc.memory_search", { query: "pillow" }, said([{ id: "m", type: "env_quirk", title: "No Pillow", summary: "Use a venv.", ageDays: 3, confidence: 0.9 }])))).toEqual({
      kind: "memories",
      query: "pillow",
      hits: [{ type: "env_quirk", title: "No Pillow", summary: "Use a venv.", ageDays: 3 }],
    });
    expect(ownToolView(call("openorc.memory_record", { type: "lesson", title: "No Pillow", body: "Use a venv." }, said({ id: "m", recorded: true })))).toEqual({
      kind: "remembered",
      type: "lesson",
      title: "No Pillow",
      body: "Use a venv.",
    });
  });

  it("reads nothing from another server's tool of the same name, an answer of another shape, a failure, or a call with no answer yet", () => {
    expect(ownToolView(call("slack.thread_list", {}, said([thread])))).toBeNull();
    expect(ownToolView(call("openorc.thread_list", {}, said({ threads: "none" })))).toBeNull();
    expect(ownToolView(call("openorc.thread_list", {}, said([{ name: "not a thread" }])))).toBeNull();
    expect(ownToolView(call("openorc.thread_list", {}, "No project here.", { isError: true }))).toBeNull();
    expect(ownToolView(call("openorc.thread_list", {}, undefined, { done: false }))).toBeNull();
  });

  it("reads an answer the page left out once it is handed in", () => {
    const paged = call("openorc.thread_list", {}, undefined, { outputOmitted: true });
    expect(ownToolView(paged)).toBeNull();
    expect(ownToolView(paged, said([thread]))).toMatchObject({ kind: "threads" });
  });
});

it("gives a call's line what its answer adds: the thing by name, and what it came to", () => {
  expect(ownToolLine({ kind: "threads", threads: [thread as never] })).toEqual({ result: "1 thread" });
  expect(
    ownToolLine({
      kind: "thread",
      thread: thread as never,
      messages: [
        { role: "assistant", text: "a" },
        { role: "user", text: "b" },
      ],
    }),
  ).toEqual({ name: "Cloud threads", result: "last 2 messages" });
  expect(ownToolLine({ kind: "sent", text: "Hi", delivered: false, landed: "Its thread is closed." })).toEqual({ result: "Not delivered" });
  expect(ownToolLine({ kind: "memories", query: "x", hits: [] })).toEqual({ result: "Nothing found" });
  // The line a step draws carries both.
  const [read] = workObjects([call("openorc.thread_read", { id: "t1" }, said({ thread, messages: [{ role: "assistant", text: "Done." }] }))]);
  expect(read).toMatchObject({ kind: "tool", section: "Read thread", named: "Cloud threads", came: "last 1 message" });
  expect(objectOutcome(read!)).toEqual({ text: "last 1 message", failed: false });
});

describe("noticeFrom", () => {
  const id = "d3918d7a-6859-4f1a-be06-6ac18ed18ba8";

  it("reads a message from another thread apart from its opening", () => {
    expect(noticeFrom(`Message from the thread "Dictation "v2" options" (id ${id}):\n\nShipped.\n\nTests pass.`)).toEqual({
      lead: "From",
      name: 'Dictation "v2" options',
      threadId: id,
      text: "Shipped.\n\nTests pass.",
    });
  });

  it("reads the thread that started this one, without the instructions to its agent", () => {
    const opening = `The thread "iPad release" (id ${id}) started this thread and works in the same folder. Message it with thread_send when you have results or need something from it; don't reply just to acknowledge.`;
    expect(noticeFrom(`${opening}\n\nBump the version.`)).toEqual({ lead: "Started by", name: "iPad release", threadId: id, text: "Bump the version." });
  });

  it("reads an Orcling, which has no thread to open", () => {
    const message = "Message from Mira, the person's Orcling. It reads your replies in this thread and can't be messaged back, so answer here:\n\nHow is it going?";
    expect(noticeFrom(message)).toEqual({ lead: "From", name: "Mira", threadId: null, text: "How is it going?" });
    const started = "Mira, the person's Orcling, started this task for them. It reads your replies here and may message you; answer in this thread, since it can't be messaged back.\n\nFix the build.";
    expect(noticeFrom(started)).toEqual({ lead: "Started by", name: "Mira", threadId: null, text: "Fix the build." });
    expect(noticeFrom("Mira started this thread.\n\nFix the build.")).toEqual({ lead: "Started by", name: "Mira", threadId: null, text: "Fix the build." });
  });

  it("leaves OpenOrc's own notices alone", () => {
    expect(noticeFrom("Switched to Opus at high effort.")).toBeNull();
    expect(noticeFrom("The task finished.\n\nMira started this thread. Then it stopped.")).toBeNull();
  });
});
