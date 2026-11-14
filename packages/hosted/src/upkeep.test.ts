import { hostedRunId, type RpcParams } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs, type Device, type Seen } from "./test-fixtures/host.js";
import { standIn, type StandIn, type StandInBilling } from "./testing/stand-in.js";

const ADA = "ada@example.com";
const PRO: StandInBilling = { pro: true, standing: "live", at: new Date(Date.now() + 20 * 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 };
const DAY = 86_400_000;

let stand: StandIn;
let device: Device;
const hosts: Hosted[] = [];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  device = newDevice();
  device.projects = [{ id: "mac-openorc", remote: "git@github.com:Altalogy/openorc.git" }];
  stand.setBilling(ADA, PRO);
  stand.setSignIns(ADA, [{ agent: "claude" }]);
});

afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

async function withThread(seed: { status?: "idle" | "working" } = {}): Promise<{ hosted: Hosted; thread: string; seen: Seen }> {
  const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" });
  const thread = stand.addThread(ADA, { projectId: project, title: "Retry the cloud start", ...seed });
  const { deps, seen, browser } = hostDeps(stand, device);
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, ADA);
  await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(true));
  return { hosted, thread, seen };
}

const row = async (hosted: Hosted, thread: string) => (await hosted.threads.call("threads.get", { id: thread }))!;
const update = (hosted: Hosted, thread: string, patch: RpcParams<"threads.update">["patch"]) => hosted.threads.call("threads.update", { id: thread, patch });
const list = (hosted: Hosted, filter?: "archived") => hosted.threads.listed("threads.list", { projectIds: ["mac-openorc"], ...(filter && { filter }) })?.rows.map((each) => each.title) ?? [];

describe("a cloud row's upkeep", () => {
  it("renames the thread for everyone in it", async () => {
    const { hosted, thread } = await withThread();
    await update(hosted, thread, { title: "Wake the sandbox before the first message" });
    expect(await row(hosted, thread)).toMatchObject({ title: "Wake the sandbox before the first message" });
    expect(list(hosted)).toEqual(["Wake the sandbox before the first message"]);
  });

  it("marks the thread read and unread on the server, as far as the reader saw", async () => {
    const { hosted, thread } = await withThread();
    stand.append(thread, [{ type: "message.completed", ts: 1, messageId: "a1", role: "assistant", text: "Done" }]);
    await vi.waitFor(async () => expect(await row(hosted, thread)).toMatchObject({ unread: true }));
    await update(hosted, thread, { seen: true });
    expect(await row(hosted, thread)).toMatchObject({ unread: false });
    await update(hosted, thread, { seen: false });
    expect(await row(hosted, thread)).toMatchObject({ unread: true });
  });

  it("pins, resolves and reopens it, with the lists and Resolved's count following", async () => {
    const { hosted, thread } = await withThread();
    await update(hosted, thread, { pinned: true });
    expect((await row(hosted, thread)).pinnedAt).toEqual(expect.any(Number));
    await update(hosted, thread, { archived: true });
    expect(list(hosted)).toEqual([]);
    expect(list(hosted, "archived")).toEqual(["Retry the cloud start"]);
    expect(hosted.threads.listed("threads.resolvedCount", { projectIds: ["mac-openorc"], quietBefore: 0 })?.rows).toBe(1);
    await update(hosted, thread, { archived: false });
    expect(list(hosted)).toEqual(["Retry the cloud start"]);
  });

  it("snoozes it until a moment, and wakes it", async () => {
    const { hosted, thread } = await withThread();
    const until = Date.now() + DAY;
    await update(hosted, thread, { snoozedUntil: until });
    expect((await row(hosted, thread)).snoozedUntil).toBe(new Date(until).getTime());
    expect(hosted.threads.listed("threads.resolvedCount", { projectIds: ["mac-openorc"], quietBefore: Date.now() + 1000 })?.rows).toBe(0);
    await update(hosted, thread, { snoozedUntil: null });
    expect((await row(hosted, thread)).snoozedUntil).toBeNull();
  });

  it("deletes it from OpenOrc Cloud and the lists", async () => {
    const { hosted, thread } = await withThread();
    await hosted.threads.call("threads.delete", { id: thread });
    expect(hosted.threads.holds({ thread })).toBe(false);
    expect(list(hosted)).toEqual([]);
  });
});

describe("what a cloud thread tells the person", () => {
  it("says when it waits on an approval or a question, in this Mac's words", async () => {
    const { thread, seen } = await withThread({ status: "working" });
    const ask = stand.ask(thread, { kind: "command", toolName: "Bash", input: { command: "pnpm build" }, detail: "pnpm build" });
    await vi.waitFor(() =>
      expect(seen.notices).toEqual([
        { kind: "approval", threadId: thread, taskId: null, title: "Retry the cloud start", body: "Claude wants to run pnpm build", runId: hostedRunId(thread), approvalId: ask },
      ]),
    );
  });

  it("says a turn finished with its reply, wakes a snoozed thread, and says nothing of a turn the person stopped", async () => {
    const { hosted, thread, seen } = await withThread({ status: "working" });
    await update(hosted, thread, { snoozedUntil: Date.now() + DAY });
    stand.append(thread, [{ type: "message.completed", ts: 1, messageId: "a1", role: "assistant", text: "The wake now waits for the first health check." }]);
    stand.endTurn(thread);
    await vi.waitFor(() => expect(seen.notices).toMatchObject([{ kind: "finished", threadId: thread, body: "The wake now waits for the first health check." }]));
    await vi.waitFor(async () => expect((await row(hosted, thread)).snoozedUntil).toBeNull());
    await hosted.threads.call("runs.start", { threadId: thread, agent: "claude", mode: "act", permissionMode: "trusted", prompt: "Again", messageId: `user-${crypto.randomUUID()}` });
    await hosted.threads.call("runs.interrupt", { runId: hostedRunId(thread) });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen.notices).toHaveLength(1);
  });
});
