import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { hostedRunId, type RemotePush } from "@openorc/protocol";
import { CLOUD, cloudMac, ME, type CloudMac } from "./test-fixtures/cloud-mac.js";

/*
 * Whether a phone alone keeps an OpenOrc Cloud thread live. No window of this Mac ever asks about the threads here:
 * they are made after the Mac signed in, and only phones name them.
 */

let at: CloudMac;
beforeAll(async () => {
  at = await cloudMac();
}, 30_000);
afterAll(() => at.close());

const said = (pushes: readonly RemotePush[], runId: string, messageId: string) =>
  pushes.some((push) => push.type === "frame" && push.frame.runId === runId && push.frame.events.some((event) => event.type === "message.completed" && event.messageId === messageId));
const speak = (threadId: string, messageId: string, quiet = false) =>
  at.stand.append(threadId, [{ type: "message.completed", ts: Date.now(), messageId, role: "assistant", text: `Line ${messageId}` }], { quiet });

async function fresh(title: string) {
  const threadId = at.stand.addThread(ME, { projectId: at.cloud.projects.alder, title, status: "working" });
  const phone = await at.phone(CLOUD);
  await vi.waitFor(async () => expect((await phone.call("threads.list", { spaceId: at.cloud.alder })).map((row) => row.id)).toContain(threadId), { timeout: 5_000 });
  return { threadId, runId: hostedRunId(threadId), phone };
}

it("follows a cloud thread from the moment a phone reads its log, with no window looking at it", async () => {
  const { threadId, runId, phone } = await fresh("Opened on the phone alone");
  phone.interest([runId]);
  await phone.call("events.page", { runId });
  speak(threadId, "first");
  await vi.waitFor(() => expect(said(phone.pushes, runId, "first")).toBe(true), { timeout: 5_000 });
  speak(threadId, "second");
  await vi.waitFor(() => expect(said(phone.pushes, runId, "second")).toBe(true), { timeout: 5_000 });
});

it("does not follow a thread a phone only names in its interest: the read of the log is what starts it", async () => {
  const { threadId, runId, phone } = await fresh("Named, never read");
  phone.interest([runId]);
  speak(threadId, "unheard");
  await phone.call("projects.list", {});
  expect(said(phone.pushes, runId, "unheard")).toBe(false);
  // Opening the thread reads the log, which holds what was said, and what is said next arrives by itself.
  expect((await phone.call("events.page", { runId })).events).toContainEqual(expect.objectContaining({ messageId: "unheard" }));
  speak(threadId, "heard");
  await vi.waitFor(() => expect(said(phone.pushes, runId, "heard")).toBe(true), { timeout: 5_000 });
});

it("loses no line when a frame is lost on its way to this Mac: the phone is handed it, or told to read the log again", async () => {
  const { threadId, runId, phone } = await fresh("A frame lost");
  phone.interest([runId]);
  await phone.call("events.page", { runId });
  speak(threadId, "lost", true);
  at.stand.endTurn(threadId);
  await vi.waitFor(() => expect(said(phone.pushes, runId, "lost") || phone.gaps.flat().includes(runId)).toBe(true), { timeout: 5_000 });
  expect((await phone.call("events.page", { runId })).events).toContainEqual(expect.objectContaining({ messageId: "lost" }));
});
