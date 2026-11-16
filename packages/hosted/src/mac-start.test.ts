import { hostedRunId, type AgentEvent } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import type { MacWorkUpload } from "./mac-start.js";
import { hostDeps, newDevice, signInAs, type Device } from "./test-fixtures/host.js";
import { standIn, type StandIn, type StandInBilling } from "./testing/stand-in.js";

const ADA = "ada@example.com";
const PRO: StandInBilling = { pro: true, standing: "live", at: new Date(Date.now() + 20 * 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 };
const SETTINGS = { agent: "claude", model: "opus", mode: "act", permissionMode: "trusted" } as const;
const QUERY = { base: "a".repeat(40), headSha: "b".repeat(40), headTreeSha: "c".repeat(40), treeSha: "d".repeat(40), wip: "e".repeat(40) };
let stand: StandIn;
let device: Device;
const hosts: Hosted[] = [];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  device = newDevice();
  device.projects = [{ id: "mac-tools", remote: "git@github.com:example/tools.git" }];
  stand.setBilling(ADA, PRO);
  stand.setSignIns(ADA, [{ agent: "claude" }]);
  stand.threadFiles.capabilities = { macCode: { available: true } };
});

afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

/** Ada signed in, the project on OpenOrc Cloud, and this Mac's packer standing in as `pack` says. */
async function signedIn(pack: () => Promise<MacWorkUpload | null>) {
  stand.addProject(ADA, { name: "tools", fullName: "example/tools" });
  const macWork = vi.fn(pack);
  const { deps, browser } = hostDeps(stand, device, { macWork });
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, ADA);
  await hosted.spaces.refresh();
  await vi.waitFor(async () => expect(await hosted.threads.macStartOffered?.("mac-tools")).toBe(true));
  return { hosted, macWork };
}

const upload = (refusal: string | null = null) => {
  const done = vi.fn(async () => undefined);
  const made: MacWorkUpload = {
    query: QUERY,
    refusal,
    chunks: async function* () {
      yield new TextEncoder().encode("PACKED-WORK");
    },
    done,
  };
  return { made, done };
};

const start = (hosted: Hosted) =>
  hosted.threads.call("threads.start", { projectId: "mac-tools", hosted: true, ...SETTINGS, prompt: "Carry on from here", attachments: [], macWork: { include: [".env.local"] } });

describe("a cloud thread started from this Mac's folder", () => {
  it("makes the thread with no message, sends the Mac's work as its first save, then the first message", async () => {
    const { made, done } = upload();
    const { hosted, macWork } = await signedIn(async () => made);
    const started = await start(hosted);
    expect(macWork).toHaveBeenCalledWith("mac-tools", [".env.local"]);
    expect(stand.started[0]!.body).not.toHaveProperty("first");
    expect(stand.macWork.taken).toEqual([{ threadId: started.thread.id, query: QUERY, bytes: Buffer.from("PACKED-WORK"), messagesBefore: 0 }]);
    const said = (await hosted.threads.call("events.page", { runId: hostedRunId(started.thread.id), turns: 10 })).events.flatMap((event: AgentEvent) =>
      event.type === "message.completed" && event.role === "user" ? [event.text] : [],
    );
    expect(said).toEqual(["Carry on from here"]);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("refuses in the packer's words before anything is sent, and starts as before when the folder holds nothing new", async () => {
    const { made, done } = upload("Too large to send from this Mac: video.bin (51 MB), over 50 MB each.");
    let next: MacWorkUpload | null = made;
    const { hosted } = await signedIn(async () => next);
    await expect(start(hosted)).rejects.toThrow("Too large to send from this Mac: video.bin (51 MB), over 50 MB each.");
    expect(stand.started).toEqual([]);
    expect(stand.macWork.taken).toEqual([]);
    expect(done).toHaveBeenCalledTimes(1);
    next = null;
    await start(hosted);
    expect(stand.started[0]!.body).toHaveProperty("first");
    expect(stand.macWork.taken).toEqual([]);
  });

  it("is not offered where the server doesn't take it", async () => {
    const { hosted } = await signedIn(async () => null);
    stand.threadFiles.capabilities = { macCode: { available: false, reason: "Code from this Mac isn't available in cloud threads yet." } };
    expect(await hosted.threads.macStartOffered?.("mac-tools")).toBe(false);
    expect(await hosted.threads.macStartOffered?.("mac-elsewhere")).toBe(false);
  });
});
