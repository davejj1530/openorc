import { randomUUID } from "node:crypto";
import { hostedFilePath, hostedRunId, type AgentEvent } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs, type Device } from "./test-fixtures/host.js";
import { standIn, type StandIn, type StandInBilling } from "./testing/stand-in.js";

const ADA = "ada@example.com";
const SPACE = `personal-${ADA}`;
const PRO: StandInBilling = { pro: true, standing: "live", at: new Date(Date.now() + 20 * 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 };
const SETTINGS = { agent: "claude", model: "opus", mode: "act", permissionMode: "trusted" } as const;
const FILES_ON = { files: { available: true as const } };

let stand: StandIn;
let device: Device;
const hosts: Hosted[] = [];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  device = newDevice();
  device.projects = [{ id: "mac-openorc", remote: "git@github.com:Acme/openorc.git" }];
  stand.setBilling(ADA, PRO);
  stand.setSignIns(ADA, [{ agent: "claude" }]);
  stand.threadFiles.capabilities = FILES_ON;
});

afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

async function withThread(seed: { status?: "idle" | "working" } = {}) {
  const project = stand.addProject(ADA, { name: "openorc", fullName: "acme/openorc" });
  const thread = stand.addThread(ADA, { projectId: project, title: "Read the attached notes", ...seed });
  const { deps, browser } = hostDeps(stand, device);
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, ADA);
  await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(true));
  await hosted.spaces.refresh();
  return { hosted, thread, project, run: hostedRunId(thread) };
}

/** A finished upload of Ada's for a hosted thread, as the composer leaves it: its path in the thread's log form. */
async function uploaded(hosted: Hosted, project: string, name: string, text: string): Promise<string> {
  const status = hosted.spaces.status();
  if (status.state !== "ready") throw new Error("Expected spaces");
  const scope = await hosted.files.capture({ accountId: status.userId, apiOrigin: status.apiOrigin, spaceId: SPACE, destination: { kind: "hosted", projectId: project } });
  const bytes = Buffer.from(text);
  const plan = await hosted.files.start(scope, { name, bytes: bytes.length, requestId: randomUUID() });
  await hosted.files.part(
    scope,
    plan,
    1,
    { bytes: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) },
    { signal: new AbortController().signal, progress: () => undefined },
  );
  return hostedFilePath(await hosted.files.complete(scope, plan.id));
}

const logged = async (hosted: Hosted, run: string) =>
  (await hosted.threads.call("events.page", { runId: run, turns: 10 })).events.flatMap((event: AgentEvent) =>
    event.type === "message.completed" && event.role === "user" ? [{ text: event.text, attachments: event.attachments ?? [] }] : [],
  );
const fileIdsSent = () => stand.sent.map((each) => each.body["fileIds"] ?? []);
const row = async (hosted: Hosted, thread: string) => (await hosted.threads.call("threads.get", { id: thread }))!;

describe("files in a message to an OpenOrc Cloud thread", () => {
  it("sends the chosen files by id in the order chosen, and the log names each where the app reads it", async () => {
    const { hosted, thread, project, run } = await withThread();
    const notes = await uploaded(hosted, project, "notes.txt", "first");
    const plan = await uploaded(hosted, project, "plan.md", "second");
    await hosted.threads.call("runs.start", { threadId: thread, ...SETTINGS, prompt: "Read these", attachments: [plan, notes], messageId: `user-${randomUUID()}` });
    expect(fileIdsSent()).toEqual([[idOf(plan), idOf(notes)]]);
    expect(await logged(hosted, run)).toEqual([{ text: "Read these", attachments: [plan, notes] }]);
  });

  it("shows a queued message's files, and Send now and a refused message's retry keep them", async () => {
    const { hosted, thread, project, run } = await withThread({ status: "working" });
    const notes = await uploaded(hosted, project, "notes.txt", "first");
    const queued = await hosted.threads.call("threads.queue", { id: thread, text: "Then read this", attachments: [notes], requestKey: randomUUID() });
    expect(queued).toMatchObject([{ text: "Then read this", attachments: [notes] }]);
    stand.setBilling(ADA, { ...PRO, monthlyLeftSeconds: 0 });
    stand.endTurn(thread);
    await vi.waitFor(async () => expect((await row(hosted, thread)).queued).toMatchObject([{ attachments: [notes], error: "You're out of cloud hours." }]));
    stand.setBilling(ADA, PRO);
    expect(await hosted.threads.call("threads.sendQueued", { id: thread, messageId: queued[0]!.id })).toEqual([]);
    expect(await logged(hosted, run)).toEqual([{ text: "Then read this", attachments: [notes] }]);
  });

  it("is the same message when sent again under its id after a lost answer, and its files go once", async () => {
    const { hosted, thread, project, run } = await withThread();
    const notes = await uploaded(hosted, project, "notes.txt", "first");
    const send = { threadId: thread, ...SETTINGS, prompt: "Read these", attachments: [notes], messageId: randomUUID() };
    await hosted.threads.call("runs.start", send);
    await hosted.threads.call("runs.start", send);
    expect(await logged(hosted, run)).toEqual([{ text: "Read these", attachments: [notes] }]);
    await expect(hosted.threads.call("runs.send", { runId: run, text: "Again", attachments: [notes], messageId: randomUUID() })).rejects.toThrow(
      "Attach files you uploaded for a hosted thread, once each.",
    );
  });

  it("lets an edited queued message take the withdrawn one's files, keeping the withdrawn record", async () => {
    const { hosted, thread, project } = await withThread({ status: "working" });
    const notes = await uploaded(hosted, project, "notes.txt", "first");
    const [first] = await hosted.threads.call("threads.queue", { id: thread, text: "Read this", attachments: [notes], requestKey: randomUUID() });
    await hosted.threads.call("threads.unqueue", { id: thread, messageId: first!.id });
    const edited = await hosted.threads.call("threads.queue", { id: thread, text: "Read this first", attachments: [notes], requestKey: randomUUID() });
    expect(edited).toMatchObject([{ text: "Read this first", attachments: [notes] }]);
    expect(fileIdsSent()).toEqual([[idOf(notes)], [idOf(notes)]]);
  });

  it("refuses in the server's words while it does not take files, and sends nothing", async () => {
    const { hosted, run } = await withThread({ status: "working" });
    stand.threadFiles.capabilities = { files: { available: false, reason: "Files aren't on for this space yet." } };
    await expect(hosted.threads.call("runs.send", { runId: run, text: "See this", attachments: ["/hosted/files/f1/notes.txt"] })).rejects.toThrow("Files aren't on for this space yet.");
    stand.threadFiles.capabilities = null;
    await expect(hosted.threads.call("runs.send", { runId: run, text: "See this", attachments: ["/hosted/files/f1/notes.txt"] })).rejects.toThrow("Files can't be sent to OpenOrc Cloud yet.");
    expect(stand.sent).toEqual([]);
  });

  it("never sends a path of this Mac to the cloud", async () => {
    const { hosted, run } = await withThread({ status: "working" });
    await expect(hosted.threads.call("runs.send", { runId: run, text: "See this", attachments: ["/Users/ada/shot.png"] })).rejects.toThrow("This file isn't available in this space.");
    expect(stand.sent).toEqual([]);
  });
});

function idOf(path: string): string {
  return path.split("/")[3]!;
}
