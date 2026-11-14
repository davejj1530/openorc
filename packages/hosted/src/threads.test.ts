import type { RpcParams } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs, type TestBrowser, type Device } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADA = "ada@example.com";
const LIST: RpcParams<"threads.list"> = { projectIds: ["mac-openorc", "openorc-workspace"], filter: "active", includeChildren: true };

let stand: StandIn;
let device: Device;
const hosts: Hosted[] = [];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  device = newDevice();
  device.projects = [{ id: "mac-openorc", remote: "git@github.com:Altalogy/openorc.git" }];
});

afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

/** Each host's browser, which signs it in. */
const browsers = new WeakMap<Hosted, TestBrowser>();

async function host() {
  const { deps, seen, browser } = hostDeps(stand, device);
  const hosted = createHosted(deps);
  hosts.push(hosted);
  browsers.set(hosted, browser);
  await hosted.start();
  return { hosted, seen };
}

async function signIn(hosted: Hosted) {
  await signInAs(hosted, browsers.get(hosted)!, ADA);
}

const listed = (hosted: Hosted) => hosted.threads.listed("threads.list", LIST)?.rows ?? [];

describe("hosted threads", () => {
  it("lists nothing and holds nothing while nobody is signed in", async () => {
    const { hosted } = await host();
    expect(hosted.threads.active).toBe(false);
    expect(hosted.threads.listed("threads.list", LIST)).toBeNull();
    expect(hosted.threads.holds({ thread: "anything" })).toBe(false);
    expect(stand.requests).toEqual([]);
  });

  it("puts each thread under the Mac project with its repository, or under its own when this Mac has none", async () => {
    const openorc = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" });
    const website = stand.addProject(ADA, { name: "website", fullName: "altalogy/website" });
    const retry = stand.addThread(ADA, { projectId: openorc, title: "Retry the cloud start", status: "working" });
    const hero = stand.addThread(ADA, { projectId: website, title: "Redraw the hero" });
    const { hosted } = await host();
    await signIn(hosted);
    await vi.waitFor(() => expect(listed(hosted)).toHaveLength(2));
    const rows = new Map(listed(hosted).map((row) => [row.id, row]));
    expect(rows.get(retry)).toMatchObject({ projectId: "mac-openorc", title: "Retry the cloud start", activity: "running", liveRunId: `hosted:${retry}`, owner: { brain: "hosted", reach: "live" } });
    expect(rows.get(retry)?.owner?.project).toBeUndefined();
    expect(rows.get(hero)).toMatchObject({ projectId: `openorc-cloud:${website}`, activity: "idle", owner: { brain: "hosted", project: { name: "website" } } });
    expect(hosted.threads.holds({ thread: retry })).toBe(true);
    expect(hosted.threads.holds({ run: `hosted:${hero}` })).toBe(true);
    expect(hosted.threads.holds({ thread: "a-mac-thread" })).toBe(false);
    expect(hosted.threads.project(`openorc-cloud:${website}`)).toMatchObject({ name: "website", gitRemote: "https://github.com/altalogy/website" });
    expect(hosted.threads.listed("threads.list", { projectId: "mac-openorc" })?.rows.map((row) => row.id)).toEqual([retry]);
  });

  it("is unread once the agent writes past what the person has seen, and not for their own message", async () => {
    const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" });
    const thread = stand.addThread(ADA, { projectId: project, title: "Ask" });
    stand.append(thread, [{ type: "message.completed", messageId: "m1", role: "user", text: "Hello" }], { by: "user-ada" });
    const { hosted } = await host();
    await signIn(hosted);
    await vi.waitFor(() => expect(listed(hosted)).toHaveLength(1));
    expect(listed(hosted)[0]).toMatchObject({ unread: false });
    stand.append(thread, [{ type: "message.completed", messageId: "m2", role: "assistant", text: "Hi" }]);
    await vi.waitFor(() => expect(listed(hosted)[0]).toMatchObject({ unread: true }));
  });

  it("reads the list again when the server says threads changed", async () => {
    const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" });
    const { hosted, seen } = await host();
    await signIn(hosted);
    await vi.waitFor(() => expect(hosted.threads.active).toBe(true));
    const thread = stand.addThread(ADA, { projectId: project, title: "New on the phone" });
    await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(true));
    expect(seen.pushes).toContainEqual({ type: "invalidate", keys: ["threads", `runs:thread:${thread}`] });
  });

  it("refreshes only changed runs, without refreshing a working run for each row change", async () => {
    const first = stand.addThread(ADA, { projectId: null, title: "First report", status: "working" });
    const second = stand.addThread(ADA, { projectId: null, title: "Second report", status: "working" });
    for (const id of [first, second]) stand.append(id, [{ type: "turn.started", ts: 1, turnId: id }]);
    const { hosted, seen } = await host();
    await signIn(hosted);
    await vi.waitFor(() => expect(hosted.threads.holds({ thread: first }) && hosted.threads.holds({ thread: second })).toBe(true));
    seen.pushes.length = 0;
    await hosted.threads.call("threads.update", { id: first, patch: { title: "Updated report" } });
    expect(seen.pushes).toEqual([{ type: "invalidate", keys: ["threads"] }]);
    seen.pushes.length = 0;
    await hosted.threads.call("threads.update", { id: first, patch: { model: "sonnet" } });
    expect(seen.pushes).toEqual([{ type: "invalidate", keys: ["threads", `runs:thread:${first}`] }]);
    seen.pushes.length = 0;
    stand.endTurn(first);
    await vi.waitFor(async () => expect(await hosted.threads.call("runs.listForThread", { threadId: first })).toMatchObject([{ endedAt: expect.any(Number) }]));
    expect(seen.pushes).toEqual([
      { type: "invalidate", keys: ["threads", `runs:thread:${first}`] },
      { type: "gap", runIds: [`hosted:${first}`] },
    ]);
  });

  it.each(["delete", "sign out"] as const)("invalidates a removed row without trying to reload its transcript on %s", async (way) => {
    const thread = stand.addThread(ADA, { projectId: null, title: "Temporary report", status: "working" });
    stand.append(thread, [{ type: "turn.started", ts: 1, turnId: thread }]);
    const { hosted, seen } = await host();
    await signIn(hosted);
    await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(true));
    seen.pushes.length = 0;
    if (way === "delete") await hosted.threads.call("threads.delete", { id: thread });
    else await hosted.account.signOut();
    await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(false));
    expect(seen.pushes).toContainEqual({ type: "invalidate", keys: ["threads", `runs:thread:${thread}`] });
    expect(seen.pushes).not.toContainEqual(expect.objectContaining({ type: "gap" }));
  });

  it("keeps its rows through a restart with the server down, offline, and lets them go on sign-out", async () => {
    const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" });
    const thread = stand.addThread(ADA, { projectId: project, title: "Kept" });
    const first = await host();
    await signIn(first.hosted);
    await vi.waitFor(() => expect(listed(first.hosted)).toHaveLength(1));
    first.hosted.close();
    await stand.down();
    const { hosted, seen } = await host();
    expect(listed(hosted)).toMatchObject([{ id: thread, owner: { brain: "hosted", reach: "offline" } }]);
    await hosted.account.signOut();
    expect(hosted.threads.active).toBe(false);
    expect(hosted.threads.holds({ thread })).toBe(false);
    expect(device.threads).toBeNull();
    expect(seen.pushes).toContainEqual({ type: "invalidate", keys: ["threads", `runs:thread:${thread}`] });
  });

  it("draws an event it cannot read as one plain line in its place, never leaving it out", async () => {
    const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" });
    const thread = stand.addThread(ADA, { projectId: project, title: "Newer server" });
    stand.append(thread, [
      { type: "message.completed", ts: 1, messageId: "m1", role: "assistant", text: "Before" },
      { type: "review.requested", ts: 2, reviewer: "sam" },
      { type: "tool.started", ts: 3, toolCallId: "c1" },
      { type: "message.completed", ts: 4, messageId: "m2", role: "assistant", text: "After" },
    ]);
    const { hosted } = await host();
    await signIn(hosted);
    await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(true));
    const page = await hosted.threads.call("events.page", { runId: `hosted:${thread}`, turns: 4 });
    expect(page.events.map((event) => (event.type === "message.completed" ? `${event.role}: ${event.text}` : event.type))).toEqual([
      "assistant: Before",
      "system: Update OpenOrc to see this step.",
      "system: Update OpenOrc to see this step.",
      "assistant: After",
    ]);
  });

  it("shows nothing as running while the server can't be reached, and keeps an ask waiting", async () => {
    const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" });
    const working = stand.addThread(ADA, { projectId: project, title: "Working", status: "working", backgroundCommands: [{ id: "dev", description: "pnpm dev" }] });
    const asking = stand.addThread(ADA, { projectId: project, title: "Asking", status: "needs_answer" });
    stand.append(working, [{ type: "turn.started", ts: 1, turnId: "t1" }]);
    const first = await host();
    await signIn(first.hosted);
    await vi.waitFor(() => expect(listed(first.hosted)).toHaveLength(2));
    expect(listed(first.hosted).find((row) => row.id === working)).toMatchObject({ activity: "running", liveRunId: `hosted:${working}` });
    first.hosted.close();
    await stand.down();
    const { hosted } = await host();
    const rows = new Map(listed(hosted).map((row) => [row.id, row]));
    expect(rows.get(working)).toMatchObject({ activity: "idle", liveRunId: null, session: { status: "idle" }, backgroundCommands: [], owner: { reach: "offline" } });
    expect(rows.get(asking)).toMatchObject({ activity: "waiting" });
    expect(await hosted.threads.call("runs.listForThread", { threadId: working })).toMatchObject([{ state: "success" }]);
  });

  it("counts the quiet roots Resolved files by age, but never one waiting on the person", async () => {
    const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" });
    stand.addThread(ADA, { projectId: project, title: "Quiet" });
    stand.addThread(ADA, { projectId: project, title: "Asking", status: "needs_answer" });
    const { hosted } = await host();
    await signIn(hosted);
    await vi.waitFor(() => expect(listed(hosted)).toHaveLength(2));
    const count = (quietBefore: number) => hosted.threads.listed("threads.resolvedCount", { projectIds: ["mac-openorc"], quietBefore })?.rows;
    expect(count(Date.now() + 60_000)).toBe(1);
    expect(count(Date.now() - 60_000)).toBe(0);
    expect(hosted.threads.listed("threads.resolvedCount", { projectIds: ["another-mac-project"], quietBefore: Date.now() + 60_000 })?.rows).toBe(0);
  });
});

describe("a team's threads", () => {
  const BOB = "bob@example.com";

  async function hostAs(email: string, on = newDevice()) {
    on.projects = device.projects;
    const { deps, seen, browser } = hostDeps(stand, on);
    const hosted = createHosted(deps);
    hosts.push(hosted);
    await hosted.start();
    await signInAs(hosted, browser, email);
    return { hosted, seen };
  }

  it("lists every space's threads, names a teammate as the starter, and asks about each thread in its space", async () => {
    const team = stand.addTeam("Altalogy", [ADA, BOB]);
    const shared = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" }, team);
    const own = stand.addProject(BOB, { name: "notes", fullName: "bob/notes" });
    const adas = stand.addThread(ADA, { projectId: shared, title: "Ada's in the team" });
    const bobs = stand.addThread(BOB, { projectId: own, title: "Bob alone" });
    stand.append(adas, [{ type: "message.completed", ts: 1, messageId: "a1", role: "assistant", text: "Done" }]);
    const { hosted: bob } = await hostAs(BOB);
    await vi.waitFor(() => expect(bob.threads.holds({ thread: adas }) && bob.threads.holds({ thread: bobs })).toBe(true));
    const rows = new Map((bob.threads.listed("threads.list", { filter: "active", includeChildren: true })?.rows ?? []).map((row) => [row.id, row]));
    expect(rows.get(adas)?.owner).toMatchObject({ brain: "hosted", startedBy: { name: "Ada", image: null } });
    expect(rows.get(bobs)?.owner?.startedBy).toBeUndefined();
    const page = await bob.threads.call("events.page", { runId: `hosted:${adas}`, turns: 1 });
    expect(page.events.map((event) => event.type)).toEqual(["message.completed"]);
    await expect(bob.threads.call("runs.send", { runId: `hosted:${adas}`, text: "Mine now" })).rejects.toThrow("You can read this thread, but only the people in it can send to it or act on it.");
    await bob.threads.call("threads.update", { id: adas, patch: { pinned: true } });
    expect(bob.threads.listed("threads.list", { pinnedOnly: true })?.rows.map((row) => row.id)).toEqual([adas]);
  });

  it("never asks a teammate's thread to be ready, since only its starter writes to it", async () => {
    const team = stand.addTeam("Altalogy", [ADA, BOB]);
    const shared = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" }, team);
    const adas = stand.addThread(ADA, { projectId: shared, title: "Ada's" });
    stand.setBilling(BOB, { pro: true, standing: "live", at: new Date(Date.now() + 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 });
    stand.setSignIns(BOB, [{ agent: "claude" }]);
    const { hosted: bob } = await hostAs(BOB);
    await vi.waitFor(() => expect(bob.threads.holds({ thread: adas })).toBe(true));
    await bob.threads.call("threads.ready", { id: adas });
    expect(stand.requests.some((request) => request.path.endsWith("/ready"))).toBe(false);
  });

  it("tells an app too old for the server to update, in the server's words", async () => {
    const old = newDevice();
    const { deps } = hostDeps(stand, old, { fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), "x-openorc-protocol": "0" } }) });
    const hosted = createHosted(deps);
    hosts.push(hosted);
    await hosted.start();
    await hosted.account.signIn();
    expect(hosted.account.status()).toMatchObject({
      state: "signed-out",
      signingIn: { state: "failed", error: "This version of OpenOrc is too old for OpenOrc Cloud. Update OpenOrc to keep using it." },
    });
  });
});
