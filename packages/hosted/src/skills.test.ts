import { createHash } from "node:crypto";
import { hostedRunId } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHosted, type Hosted, type OwnSkill } from "./index.js";
import { hostDeps, newDevice, signInAs, type Device } from "./test-fixtures/host.js";
import { standIn, type StandIn, type StandInBilling } from "./testing/stand-in.js";

const ADA = "ada@example.com";
const PRO: StandInBilling = { pro: true, standing: "live", at: new Date(Date.now() + 20 * 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 };
const SETTINGS = { agent: "claude", model: "opus", mode: "act", permissionMode: "trusted" } as const;
const ON = { skills: { available: true } } as const;

let stand: StandIn;
let device: Device;
const hosts: Hosted[] = [];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  device = newDevice();
  device.projects = [{ id: "mac-openorc", remote: "git@github.com:Acme/openorc.git" }];
  stand.setBilling(ADA, PRO);
  stand.setSignIns(ADA, [{ agent: "claude" }, { agent: "codex" }]);
});

afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

type File = { path: string; text: string; runs?: boolean };

/** A skill's pack as the server reads it: its files in the order of their paths, each under the skill's folder. */
function packOf(name: string, files: readonly File[]): Buffer {
  const ordered = [...files].sort((a, b) => (a.path < b.path ? -1 : 1));
  return Buffer.concat(ordered.flatMap((file) => [Buffer.from(`${name}/${file.path}\0${file.runs ? "x" : "-"}\0${Buffer.byteLength(file.text)}\0`), Buffer.from(file.text)]));
}

/** A skill of this device's, read in small pieces as a file is. */
function skill(name: string, files: readonly File[] = [{ path: "SKILL.md", text: `Use ${name}.` }]): OwnSkill & { bytes: Buffer } {
  const bytes = packOf(name, files);
  return {
    name,
    digest: createHash("sha256").update(bytes).digest("hex"),
    bytes,
    async *pack() {
      for (let at = 0; at < bytes.length; at += 7) yield bytes.subarray(at, at + 7);
    },
  };
}

const review = skill("review", [
  { path: "SKILL.md", text: "Read the diff." },
  { path: "scripts/check.sh", text: "#!/bin/sh\necho ok\n", runs: true },
]);
const ship = skill("ship");

/** A signed-in host with one thread of the account's, heard, whose device has `own` skills. */
async function withThread(own: ((agent: string) => Promise<readonly OwnSkill[]>) | undefined, override: Parameters<typeof hostDeps>[2] = {}) {
  const project = stand.addProject(ADA, { name: "openorc", fullName: "acme/openorc" });
  const thread = stand.addThread(ADA, { projectId: project, title: "Retry the cloud start" });
  const { deps, seen, browser } = hostDeps(stand, device, { ...(own && { skills: own }), ...override });
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, ADA);
  await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(true));
  await vi.waitFor(() => {
    const status = hosted.account.status();
    expect(status.state === "signed-in" && status.signIns).toBeTruthy();
  });
  const send = (text: string, settings: Record<string, unknown> = SETTINGS) =>
    hosted.threads.call("runs.start", { threadId: thread, ...SETTINGS, ...settings, prompt: text, messageId: crypto.randomUUID() });
  /** The requests made since the last call, by path, without the reads a send makes after it. */
  let from = seen.timeline.length;
  const asked = () => {
    const paths = seen.timeline.slice(from).flatMap((line) => (line.startsWith("request /hosted/") ? [line.slice("request ".length)] : []));
    from = seen.timeline.length;
    return paths.filter((path) => /skill|capabilities|messages$|ready$/.test(path));
  };
  return { hosted, thread, project, run: hostedRunId(thread), seen, send, asked };
}

describe("a person's own skills, sent before their cloud turn", () => {
  it("sends the set, then the packs the server lacks, then the set again, and only then the message", async () => {
    stand.threadFiles.capabilities = ON;
    const { send, asked, thread } = await withThread(async () => [review, ship]);
    asked();
    await send("Look at the diff");
    expect(asked()).toEqual([
      "/hosted/capabilities",
      "/hosted/skills/claude",
      `/hosted/skill-packs/${review.digest}`,
      `/hosted/skill-packs/${ship.digest}`,
      "/hosted/skills/claude",
      `/hosted/threads/${thread}/messages`,
    ]);
    expect(stand.skills.set(ADA, "claude")).toEqual(["review", "ship"]);
    expect(stand.skills.pack(ADA, review.digest)?.equals(review.bytes)).toBe(true);
    expect(stand.skills.pack(ADA, ship.digest)?.equals(ship.bytes)).toBe(true);
    expect(stand.sent).toHaveLength(1);
  });

  it("asks nothing for a set the server already keeps, and sends only the pack that is new when it changed", async () => {
    stand.threadFiles.capabilities = ON;
    let own: OwnSkill[] = [review];
    const { send, asked, thread } = await withThread(async () => own);
    await send("First");
    asked();
    await send("Second");
    expect(asked()).toEqual([`/hosted/threads/${thread}/messages`]);
    own = [review, ship];
    await send("Third");
    expect(asked()).toEqual(["/hosted/skills/claude", `/hosted/skill-packs/${ship.digest}`, "/hosted/skills/claude", `/hosted/threads/${thread}/messages`]);
    expect(stand.skills.sent.map((sent) => sent.digest)).toEqual([review.digest, ship.digest]);
    // None at all is a set too: the server is told, and no pack goes.
    own = [];
    await send("Fourth");
    expect(asked()).toEqual(["/hosted/skills/claude", `/hosted/threads/${thread}/messages`]);
    expect(stand.skills.set(ADA, "claude")).toEqual([]);
  });

  it("sends the skills of the agent the turn would run with", async () => {
    stand.threadFiles.capabilities = ON;
    const wanted: string[] = [];
    const { send } = await withThread(async (agent) => {
      wanted.push(agent);
      return agent === "codex" ? [ship] : [review];
    });
    await send("With Codex", { agent: "codex", model: null });
    expect(wanted).toEqual(["codex"]);
    expect(stand.skills.set(ADA, "codex")).toEqual(["ship"]);
    expect(stand.skills.set(ADA, "claude")).toBeNull();
  });

  it("sends nothing to a server that has no capabilities, and asks it once", async () => {
    const own = vi.fn(async () => [review]);
    const { send, asked, thread } = await withThread(own);
    asked();
    await send("First");
    await send("Second");
    expect(asked()).toEqual(["/hosted/capabilities", `/hosted/threads/${thread}/messages`, `/hosted/threads/${thread}/messages`]);
    expect(own).not.toHaveBeenCalled();
    expect(stand.skills.asked).toEqual([]);
  });

  it("sends nothing while the server says skills are not available, and starts once it says they are", async () => {
    stand.threadFiles.capabilities = { skills: { available: false, reason: "Your skills aren't available in cloud threads yet." } };
    let now = 1_000_000;
    const own = vi.fn(async () => [review]);
    const { send, asked, thread } = await withThread(own, { now: () => now });
    asked();
    await send("First");
    await send("Second");
    expect(asked()).toEqual(["/hosted/capabilities", `/hosted/threads/${thread}/messages`, `/hosted/threads/${thread}/messages`]);
    expect(own).not.toHaveBeenCalled();
    stand.threadFiles.capabilities = ON;
    now += 61_000;
    await send("Third");
    expect(stand.skills.set(ADA, "claude")).toEqual(["review"]);
  });

  it("goes on without skills when the server turned them off since it was asked", async () => {
    stand.threadFiles.capabilities = ON;
    let own: OwnSkill[] = [review];
    const { send, asked, thread } = await withThread(async () => own);
    await send("First");
    stand.threadFiles.capabilities = { skills: { available: false, reason: "Your skills aren't available in cloud threads yet." } };
    own = [review, ship];
    asked();
    await send("Second");
    expect(asked()).toEqual(["/hosted/skills/claude", `/hosted/threads/${thread}/messages`]);
    expect(stand.sent).toHaveLength(2);
    expect(stand.skills.set(ADA, "claude")).toEqual(["review"]);
  });

  it("asks nothing at all on a device that has no skills to give", async () => {
    stand.threadFiles.capabilities = ON;
    const { send, asked, thread } = await withThread(undefined);
    asked();
    await send("First");
    expect(asked()).toEqual([`/hosted/threads/${thread}/messages`]);
  });

  it("holds the message with the server's sentence when a skill is refused, and sends it once the skill is right", async () => {
    stand.threadFiles.capabilities = ON;
    const broken = skill("notes", [{ path: "README.md", text: "No skill file." }]);
    let own: OwnSkill[] = [review, broken];
    const { send, asked, thread } = await withThread(async () => own);
    asked();
    await expect(send("Look at the diff")).rejects.toThrow("notes has no SKILL.md, so it isn't a skill.");
    expect(stand.sent).toEqual([]);
    expect(stand.skills.set(ADA, "claude")).toBeNull();
    asked();
    own = [review, skill("notes")];
    await send("Look at the diff");
    expect(asked()).toEqual(["/hosted/skills/claude", expect.stringMatching(/^\/hosted\/skill-packs\//), "/hosted/skills/claude", `/hosted/threads/${thread}/messages`]);
    expect(stand.sent).toHaveLength(1);
    expect(stand.skills.set(ADA, "claude")).toEqual(["notes", "review"]);
  });

  it("holds the message when this device cannot read a skill, with what it says", async () => {
    stand.threadFiles.capabilities = ON;
    const unreadable: OwnSkill = {
      ...ship,
      async *pack() {
        throw new Error("ship changed while it was being sent. Send again.");
      },
    };
    const { send } = await withThread(async () => [unreadable]);
    await expect(send("Look at the diff")).rejects.toThrow("ship changed while it was being sent. Send again.");
    expect(stand.sent).toEqual([]);
  });

  it("holds the message when the skills on this device cannot be listed", async () => {
    stand.threadFiles.capabilities = ON;
    const { send } = await withThread(async () => {
      throw new Error("Codex could not list skills for this project.");
    });
    await expect(send("Look at the diff")).rejects.toThrow("Codex could not list skills for this project.");
    expect(stand.sent).toEqual([]);
  });

  it("holds the message when the server cannot be reached with a pack", async () => {
    stand.threadFiles.capabilities = ON;
    const { send } = await withThread(async () => [review], {
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname.startsWith("/hosted/skill-packs/")) throw new TypeError("fetch failed");
        return fetch(input, init);
      },
    });
    await expect(send("Look at the diff")).rejects.toThrow("OpenOrc Cloud can't be reached.");
    expect(stand.sent).toEqual([]);
  });

  it("sends them before a thread is made ready, and makes it ready whatever came of that", async () => {
    stand.threadFiles.capabilities = ON;
    let fails = false;
    const { hosted, thread, asked } = await withThread(async () => {
      if (fails) throw new Error("Codex could not list skills for this project.");
      return [review];
    });
    asked();
    await hosted.threads.call("threads.ready", { id: thread });
    expect(asked()).toEqual(["/hosted/capabilities", "/hosted/skills/claude", `/hosted/skill-packs/${review.digest}`, "/hosted/skills/claude", `/hosted/threads/${thread}/ready`]);
    expect(stand.readies).toHaveLength(1);
    fails = true;
    const later = await withThread(async () => {
      throw new Error("Codex could not list skills for this project.");
    });
    await later.hosted.threads.call("threads.ready", { id: later.thread });
    expect(stand.readies).toHaveLength(2);
  });

  it("sends them in the project's space before a new thread is started there", async () => {
    stand.threadFiles.capabilities = ON;
    const { hosted, asked } = await withThread(async () => [review]);
    asked();
    await hosted.threads.call("threads.start", { projectId: "mac-openorc", ...SETTINGS, prompt: "Start here" });
    expect(asked()).toEqual(["/hosted/capabilities", "/hosted/skills/claude", `/hosted/skill-packs/${review.digest}`, "/hosted/skills/claude"]);
    expect(stand.started).toHaveLength(1);
    expect(stand.skills.set(ADA, "claude")).toEqual(["review"]);
  });

  it("starts no thread when the skills could not be sent", async () => {
    stand.threadFiles.capabilities = ON;
    const { hosted } = await withThread(async () => [skill("notes", [{ path: "README.md", text: "No skill file." }])]);
    await expect(hosted.threads.call("threads.start", { projectId: "mac-openorc", ...SETTINGS, prompt: "Start here" })).rejects.toThrow("notes has no SKILL.md, so it isn't a skill.");
    expect(stand.started).toEqual([]);
  });

  it("sends one set when two messages go at once", async () => {
    stand.threadFiles.capabilities = ON;
    const { send } = await withThread(async () => [review]);
    await Promise.all([send("First"), send("Second")]);
    expect(stand.skills.sent).toHaveLength(1);
    expect(stand.skills.asked).toHaveLength(2);
    expect(stand.sent).toHaveLength(2);
  });
});
