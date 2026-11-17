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
  it("refuses the unavailable speed before writing while keeping false compatible", async () => {
    const id = stand.addThread(ADA, { title: "Example", projectId: null });
    const { hosted } = await host();
    await signIn(hosted);
    await vi.waitFor(() => expect(hosted.threads.holds({ thread: id })).toBe(true));
    await expect(hosted.threads.call("threads.update", { id, patch: { fastMode: true, title: "Changed" } })).rejects.toThrow("This speed setting isn't available for this cloud agent.");
    expect(stand.requests.filter((request) => request.method === "PATCH" && request.path.endsWith(id))).toEqual([]);
    expect(await hosted.threads.call("threads.update", { id, patch: { fastMode: false, draft: "Next" } })).toMatchObject({ title: "Example", draft: "Next" });
  });

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
    // The tasks of the thread's space refresh with it too (tasks.test.ts); these are the threads' own.
    const pushes = () => seen.pushes.filter((push) => push.type !== "invalidate" || !push.keys.every((key) => key.startsWith("online-tasks:")));
    await signIn(hosted);
    await vi.waitFor(() => expect(hosted.threads.holds({ thread: first }) && hosted.threads.holds({ thread: second })).toBe(true));
    seen.pushes.length = 0;
    await hosted.threads.call("threads.update", { id: first, patch: { title: "Updated report" } });
    expect(pushes()).toEqual([{ type: "invalidate", keys: ["threads"] }]);
    seen.pushes.length = 0;
    await hosted.threads.call("threads.update", { id: first, patch: { model: "sonnet" } });
    expect(pushes()).toEqual([{ type: "invalidate", keys: ["threads", `runs:thread:${first}`] }]);
    seen.pushes.length = 0;
    stand.endTurn(first);
    await vi.waitFor(async () => expect(await hosted.threads.call("runs.listForThread", { threadId: first })).toMatchObject([{ endedAt: expect.any(Number) }]));
    expect(pushes()).toEqual([
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

  it("deletes a thread whose removal is heard before the server's reply, without calling it lost", async () => {
    const thread = stand.addThread(ADA, { projectId: null, title: "Temporary report" });
    let hosted: Hosted | null = null;
    const { deps, browser } = hostDeps(stand, device, {
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (init?.method === "DELETE" && String(url).endsWith(`/hosted/threads/${thread}`)) {
          // The server tells the thread's readers it is gone; that notice arrives first here.
          await vi.waitFor(() => expect(hosted!.threads.holds({ thread })).toBe(false));
        }
        return response;
      },
    });
    hosted = createHosted(deps);
    hosts.push(hosted);
    await hosted.start();
    await signInAs(hosted, browser, ADA);
    await vi.waitFor(() => expect(hosted!.threads.holds({ thread })).toBe(true));
    await expect(hosted.threads.call("threads.delete", { id: thread })).resolves.toBeNull();
    expect(hosted.threads.holds({ thread })).toBe(false);
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

  it("draws the server's own lines outside any turn as the thread's quiet notice, and keeps the line that ends a turn as its failure", async () => {
    const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" });
    const thread = stand.addThread(ADA, { projectId: project, title: "Refused" });
    const refusal = "You're out of cloud hours. Add hours to keep working.";
    const paused = "Mara's command is still running. Stop it before starting your turn.";
    const ended = "The agent couldn't start. Send a message to try again.";
    stand.append(thread, [{ type: "error", ts: 1, message: refusal, fatal: true }], { by: ADA });
    stand.append(thread, [{ type: "error", ts: 2, message: paused, fatal: true }]);
    stand.append(thread, [{ type: "error", ts: 3, message: ended, fatal: true }], { turnId: "t1" });
    stand.append(thread, [{ type: "error", ts: 4, message: "warning: slow disk", fatal: false }]);
    const { hosted } = await host();
    await signIn(hosted);
    await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(true));
    const page = await hosted.threads.call("events.page", { runId: `hosted:${thread}`, turns: 4 });
    expect(page.events).toEqual([
      { type: "message.completed", runId: `hosted:${thread}`, eventId: `${thread}.1`, ts: 1, messageId: `${thread}.1`, role: "system", text: refusal },
      { type: "message.completed", runId: `hosted:${thread}`, eventId: `${thread}.2`, ts: 2, messageId: `${thread}.2`, role: "system", text: paused },
      { type: "error", runId: `hosted:${thread}`, eventId: `${thread}.3`, ts: 3, message: ended, fatal: true },
      { type: "error", runId: `hosted:${thread}`, eventId: `${thread}.4`, ts: 4, message: "warning: slow disk", fatal: false },
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

  it("tells windows to read projects again when a space gains a project, so a cloud-only one asked about early appears", async () => {
    const team = stand.addTeam("Altalogy", [ADA, BOB]);
    const { hosted, seen } = await hostAs(ADA);
    await vi.waitFor(() => expect(hosted.threads.active).toBe(true));
    const added = stand.addProject(ADA, { name: "api", fullName: "acme/api" }, team);
    await (hosted.threads as unknown as { refresh(): Promise<void> }).refresh();
    expect(seen.pushes).toContainEqual({ type: "invalidate", keys: ["account", "projects"] });
    expect(hosted.threads.project(`openorc-cloud:${added}`)?.name).toBe("api");
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

describe("a new cloud thread made ready as its first message is begun", () => {
  it("asks the server once a minute a project, and never for an agent that doesn't run there", async () => {
    stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" });
    stand.setBilling(ADA, { pro: true, standing: "live", at: new Date(Date.now() + 20 * 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 });
    stand.setSignIns(ADA, [{ agent: "claude" }]);
    const { hosted } = await host();
    await signIn(hosted);
    const readies = () => stand.requests.filter((request) => request.method === "POST" && request.path === "/hosted/machines/ready");
    const start = { projectId: "mac-openorc", mode: "act", permissionMode: "autonomous" } as const;
    // Asked until the account's projects are heard: an ask for a project it doesn't know yet asks nothing.
    await vi.waitFor(async () => {
      await hosted.threads.readyStart!({ ...start, agent: "claude" });
      expect(readies()).toHaveLength(1);
    });
    await hosted.threads.readyStart!({ ...start, agent: "claude" });
    expect(readies(), "again within the minute asks nothing").toHaveLength(1);
    await hosted.threads.readyStart!({ ...start, projectId: "openorc-workspace", agent: "cursor" });
    expect(readies()).toHaveLength(1);
  });
});
