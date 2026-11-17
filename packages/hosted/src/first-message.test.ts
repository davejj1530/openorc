import { randomUUID } from "node:crypto";
import { hostedFilePath, hostedRunId, type AgentEvent } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { CLOUD_PROJECT } from "./translate.js";
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
  device.projects = [{ id: "mac-openorc", remote: "git@github.com:Altalogy/openorc.git" }];
  stand.setBilling(ADA, PRO);
  stand.setSignIns(ADA, [{ agent: "claude" }]);
  stand.threadFiles.capabilities = FILES_ON;
});

afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

async function withThread(seed: { status?: "idle" | "working" } = {}) {
  const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" });
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

it("starts in a project the window lists before this Mac's thread list has heard it, as just after sign-in", async () => {
  const { hosted } = await withThread();
  // On the server since the thread list was read: the window may list it already, from the spaces' own read.
  const added = stand.addProject(ADA, { name: "site", fullName: "altalogy/site" });
  const made = await hosted.threads.call("threads.start", { projectId: `${CLOUD_PROJECT}${added}`, spaceId: SPACE, prompt: "Start the site", ...SETTINGS });
  expect(made.thread.title).toBe("Start the site");
});

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

describe("a new OpenOrc Cloud thread with files", () => {
  const startParams = (project: string, attachments: string[], requestId: string) =>
    ({ projectId: `${CLOUD_PROJECT}${project}`, hosted: true, ...SETTINGS, prompt: "Start from these notes", attachments, requestId }) as const;

  it("starts with the files as its first message, and a start sent again under its request id is the same thread", async () => {
    const { hosted, project } = await withThread();
    const notes = await uploaded(hosted, project, "notes.txt", "first");
    const requestId = randomUUID();
    const started = await hosted.threads.call("threads.start", startParams(project, [notes], requestId));
    const again = await hosted.threads.call("threads.start", startParams(project, [notes], requestId));
    expect(again.thread.id).toBe(started.thread.id);
    expect(stand.started.map((each) => each.body)).toEqual([
      expect.objectContaining({ requestId, first: { id: requestId, text: "Start from these notes", fileIds: [idOf(notes)] } }),
      expect.objectContaining({ requestId }),
    ]);
    expect(await logged(hosted, hostedRunId(started.thread.id))).toEqual([{ text: "Start from these notes", attachments: [notes] }]);
  });

  it("starts without files exactly as before, naming no request", async () => {
    const { hosted, project } = await withThread();
    await hosted.threads.call("threads.start", startParams(project, [], randomUUID()));
    expect(stand.started[0]!.body).not.toHaveProperty("requestId");
    expect(stand.started[0]!.body["first"]).toEqual({ id: expect.any(String), text: "Start from these notes" });
  });
});

function idOf(path: string): string {
  return path.split("/")[3]!;
}
