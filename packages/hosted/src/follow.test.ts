import type { AgentEvent, Frame } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs, type Device, type Seen } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADA = "ada@example.com";

let stand: StandIn;
let device: Device;
let thread: string;
const hosts: Hosted[] = [];

const say = (text: string, role: "assistant" | "user" = "assistant") => ({ type: "message.completed", ts: Date.now(), messageId: text, role, text });
const turn = (n: number) => [say(`question ${n}`, "user"), say(`answer ${n}`), { type: "turn.completed", ts: Date.now(), turnId: `t${n}`, status: "success", durationMs: 10 }];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  device = newDevice();
  device.projects = [{ id: "mac", remote: "https://github.com/altalogy/openorc" }];
  const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" });
  thread = stand.addThread(ADA, { projectId: project, title: "Follow me", status: "working" });
  for (const n of [1, 2, 3]) stand.append(thread, turn(n));
});

afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

async function signedIn(): Promise<{ hosted: Hosted; seen: Seen }> {
  const { deps, seen, browser } = hostDeps(stand, device);
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, ADA);
  await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(true));
  return { hosted, seen };
}

const texts = (events: readonly AgentEvent[]) => events.flatMap((event) => (event.type === "message.completed" ? [event.text] : []));
/** Every event the windows were handed in frames, in order. */
const framed = (seen: Seen) => seen.pushes.flatMap((push) => ((push as { type: string }).type === "frame" ? (push as { frame: Frame }).frame.events : []));

describe("a hosted thread's log", () => {
  it("reads as one run, the newest turns first, then older turns from where the page began", async () => {
    const { hosted } = await signedIn();
    const runId = `hosted:${thread}`;
    const newest = await hosted.threads.call("events.page", { runId, turns: 1 });
    expect(newest).toMatchObject({ fromTurn: 2, live: true });
    expect(texts(newest.events)).toEqual(["question 3", "answer 3"]);
    expect(newest.events.every((event) => event.runId === runId && event.eventId?.startsWith(`${thread}.`))).toBe(true);
    const all = await hosted.threads.call("events.page", { runId, fromTurn: 0 });
    expect(texts(all.events)).toEqual(["question 1", "answer 1", "question 2", "answer 2", "question 3", "answer 3"]);
  });

  it("opens on the newest turns in one read of the log, and on a server from before that reads the turn ends first", async () => {
    const { hosted } = await signedIn();
    const runId = `hosted:${thread}`;
    const reads = () => stand.requests.filter((request) => request.method === "GET" && request.path.startsWith(`/hosted/threads/${thread}`)).map((request) => request.path);
    const before = reads().length;
    const newest = await hosted.threads.call("events.page", { runId, turns: 1 });
    expect(newest).toMatchObject({ fromTurn: 2 });
    expect(texts(newest.events)).toEqual(["question 3", "answer 3"]);
    expect(reads().slice(before), "one read: the log, and not the thread's detail").toEqual([`/hosted/threads/${thread}/events`]);

    stand.threadLog.newestTurns = false;
    const older = await hosted.threads.call("events.page", { runId, turns: 1 });
    expect(older).toEqual(newest);
  });

  it("streams what the agent writes next as frames of the thread's run", async () => {
    const { hosted, seen } = await signedIn();
    await hosted.threads.call("events.page", { runId: `hosted:${thread}`, turns: 2 });
    stand.append(thread, [say("still working")]);
    await vi.waitFor(() => expect(texts(framed(seen))).toEqual(["still working"]));
    expect(seen.pushes).toContainEqual({ type: "frame", frame: expect.objectContaining({ runId: `hosted:${thread}` }) });
  });

  it("fills in a frame lost on the way when the next one arrives", async () => {
    const { hosted, seen } = await signedIn();
    await hosted.threads.call("events.page", { runId: `hosted:${thread}`, turns: 1 });
    stand.append(thread, [say("lost")], { quiet: true });
    stand.append(thread, [say("after it")]);
    await vi.waitFor(() => expect(texts(framed(seen))).toEqual(["lost", "after it"]));
  });

  it("heals a dropped connection with nothing lost and nothing twice", async () => {
    const { hosted, seen } = await signedIn();
    await hosted.threads.call("events.page", { runId: `hosted:${thread}`, turns: 1 });
    stand.append(thread, [say("before the drop")]);
    await vi.waitFor(() => expect(texts(framed(seen))).toEqual(["before the drop"]));
    await stand.down();
    stand.append(thread, [say("while away 1"), say("while away 2")]);
    await stand.up();
    stand.append(thread, [say("back")]);
    await vi.waitFor(() => expect(texts(framed(seen))).toEqual(["before the drop", "while away 1", "while away 2", "back"]));
    const ids = framed(seen).map((event) => event.eventId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stops a command the agent left running, by its id", async () => {
    stand.set(thread, { backgroundCommands: [{ id: "dev", description: "pnpm dev" }] });
    const { hosted } = await signedIn();
    await expect(hosted.threads.call("threads.get", { id: thread })).resolves.toMatchObject({ backgroundCommands: [{ id: "dev", description: "pnpm dev" }] });
    await hosted.threads.call("threads.stopCommand", { id: thread, commandId: "dev" });
    expect(stand.stoppedCommands(thread)).toEqual(["dev"]);
  });
});
