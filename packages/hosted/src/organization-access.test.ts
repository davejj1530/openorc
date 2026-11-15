import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { hostDeps, newDevice, signInAs, testBrowser } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADMIN = "alex@example.com";
const MEMBER = "mira@example.com";
let stand: StandIn;
const hosts: Hosted[] = [];
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
});
afterEach(async () => {
  hosts.splice(0).forEach((host) => host.close());
  await stand.close();
});
async function person(email: string, overrides: Partial<HostedDeps> = {}) {
  const device = newDevice();
  device.projects = [{ id: "local-canvas", remote: "https://github.com/example/canvas" }];
  const browser = testBrowser(stand);
  const { deps, seen } = hostDeps(stand, device, { browser, ...overrides });
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, email);
  await vi.waitFor(() => expect(hosted.spaces.status().state).toBe("ready"));
  return { hosted, seen, device };
}
function project() {
  const spaceId = stand.addTeam("Birch Studio", [ADMIN, MEMBER]);
  const projectId = stand.addProject(ADMIN, { name: "Canvas", fullName: "example/canvas" }, spaceId);
  return { spaceId, projectId };
}
const isFrame = (push: unknown) => Boolean(push && typeof push === "object" && "type" in push && push.type === "frame");

it("hears a queued message before send-now even when a thread invalidation arrives during the read", async () => {
  const target = project();
  stand.setBilling(MEMBER, { pro: true, standing: "live", at: new Date(Date.now() + 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 });
  stand.setSignIns(MEMBER, [{ agent: "claude" }]);
  const id = stand.addThread(MEMBER, { projectId: target.projectId, title: "Running work", status: "working" });
  let changing = false;
  const { hosted } = await person(MEMBER, {
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (changing && new URL(String(url)).pathname === "/hosted/threads") {
        stand.set(id, { status: "working" });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return response;
    },
  });
  await vi.waitFor(() => expect(hosted.threads.holds({ thread: id })).toBe(true));
  const requestKey = randomUUID();
  changing = true;
  const queued = await hosted.threads.call("threads.queue", { id, text: "Keep the alias", requestKey });
  expect(queued.some((message) => message.id === requestKey)).toBe(true);
  await hosted.threads.call("threads.sendQueued", { id, messageId: requestKey });
  changing = false;
  expect(stand.sent.filter((message) => message.body.id === requestKey).map((message) => message.body.delivery ?? "now")).toEqual(["after", "now"]);
});

it("reads the server default, replaces chosen membership IDs atomically and refuses foreign targets", async () => {
  const target = project();
  const other = stand.addTeam("Cedar Studio", [ADMIN, "jules@example.com"]);
  const admin = (await person(ADMIN)).hosted;
  const member = (await person(MEMBER)).hosted;
  const mine = stand.spaces.member(target.spaceId, MEMBER)!.id;
  expect(await admin.spaces.access.get(target)).toEqual({ projectId: target.projectId, everyone: true, memberIds: [] });
  await expect(member.spaces.access.get(target)).rejects.toThrow("Only an admin can do that.");
  await expect(member.spaces.access.set({ ...target, everyone: true, memberIds: [] })).rejects.toThrow("Only an admin can do that.");
  const chosen = { ...target, everyone: false, memberIds: [mine] };
  expect(await admin.spaces.access.set(chosen)).toEqual({ projectId: target.projectId, everyone: false, memberIds: [mine] });
  await expect(admin.spaces.access.set({ ...chosen, memberIds: [mine, stand.spaces.member(other, "jules@example.com")!.id] })).rejects.toThrow("That person isn't in this organization.");
  expect((await admin.spaces.access.get(target)).memberIds).toEqual([mine]);
  await expect(admin.spaces.access.get({ ...target, spaceId: other })).rejects.toThrow("That project isn't here.");
  await admin.spaces.access.set({ ...target, everyone: false, memberIds: [] });
  await vi.waitFor(async () => expect(await member.spaces.projects(target.spaceId)).toEqual([]));
  expect((await admin.spaces.projects(target.spaceId)).length).toBe(1);
});

it("keeps explicit choices through Everyone, future membership and admin promotion and demotion", async () => {
  const target = project();
  const admin = (await person(ADMIN)).hosted;
  const mine = stand.spaces.member(target.spaceId, MEMBER)!.id;
  await admin.spaces.access.set({ ...target, everyone: false, memberIds: [mine] });
  await admin.spaces.membership.setRole({ spaceId: target.spaceId, memberId: mine, role: "admin" });
  await admin.spaces.access.set({ ...target, everyone: true, memberIds: [mine] });
  const future = "jules@example.com";
  stand.spaces.teams.get(target.spaceId)!.members.push({ id: randomUUID(), email: future, role: "member", createdAt: new Date().toISOString() });
  const joiner = (await person(future)).hosted;
  expect(await joiner.spaces.projects(target.spaceId)).toHaveLength(1);
  await admin.spaces.access.set({ ...target, everyone: false, memberIds: [mine] });
  await admin.spaces.membership.setRole({ spaceId: target.spaceId, memberId: mine, role: "member" });
  expect(stand.spaces.canRead(target.spaceId, target.projectId, MEMBER)).toBe(true);
  await vi.waitFor(async () => expect(await joiner.spaces.projects(target.spaceId)).toHaveLength(0));
  await admin.spaces.membership.setRole({ spaceId: target.spaceId, memberId: mine, role: "admin" });
  await admin.spaces.access.set({ ...target, everyone: false, memberIds: [] });
  expect(stand.spaces.canRead(target.spaceId, target.projectId, MEMBER)).toBe(true);
  await admin.spaces.membership.setRole({ spaceId: target.spaceId, memberId: mine, role: "member" });
  expect(stand.spaces.canRead(target.spaceId, target.projectId, MEMBER)).toBe(false);
});

it("revokes owned and teammate threads live, stops only the revoked sender and brings local folders back to Personal", async () => {
  const target = project();
  const own = stand.addThread(MEMBER, { projectId: target.projectId, title: "Own work", status: "working" });
  const teammate = stand.addThread(ADMIN, { projectId: target.projectId, title: "Other work", status: "working" });
  const admin = (await person(ADMIN)).hosted;
  const { hosted: member, seen } = await person(MEMBER);
  await vi.waitFor(() => expect(member.threads.holds({ thread: own })).toBe(true));
  await member.threads.call("events.page", { runId: `hosted:${own}` });
  await member.threads.call("events.page", { runId: `hosted:${teammate}` });
  await admin.spaces.access.set({ ...target, everyone: false, memberIds: [] });
  await vi.waitFor(() => expect(member.threads.holds({ thread: own }) || member.threads.holds({ thread: teammate })).toBe(false));
  expect(await member.spaces.projects(target.spaceId)).toEqual([]);
  expect(await member.spaces.projects(`personal-${MEMBER}`)).toEqual([expect.objectContaining({ key: "local-canvas", localProjectId: "local-canvas" })]);
  await expect(member.threads.call("events.page", { runId: `hosted:${own}` })).rejects.toThrow();
  const before = seen.pushes.filter(isFrame).length;
  stand.append(teammate, [{ type: "message.completed", ts: Date.now(), messageId: "hidden", role: "assistant", text: "Still private" }]);
  await vi.waitFor(async () => expect((await admin.threads.call("events.page", { runId: `hosted:${own}` })).live).toBe(false));
  expect(seen.pushes.filter(isFrame)).toHaveLength(before);
  const ownPage = await admin.threads.call("events.page", { runId: `hosted:${own}` });
  expect(ownPage.events).toContainEqual(expect.objectContaining({ type: "error", fatal: true, message: "This turn stopped because its sender no longer has access to this project." }));
  const completion = ownPage.events.findIndex((event) => event.type === "turn.completed");
  expect(completion).toBeGreaterThanOrEqual(0);
  expect(ownPage.events.findIndex((event) => event.type === "error")).toBeGreaterThan(completion);
  expect((await admin.threads.call("events.page", { runId: `hosted:${teammate}` })).live).toBe(true);
  await admin.spaces.access.set({ ...target, everyone: true, memberIds: [] });
  await vi.waitFor(() => expect(member.threads.holds({ thread: own })).toBe(true));
  expect((await member.threads.call("events.page", { runId: `hosted:${own}` })).live).toBe(false);
});

it("discards a successful event page delayed across revocation and regrant", async () => {
  const target = project();
  const id = stand.addThread(MEMBER, { projectId: target.projectId, title: "Delayed page" });
  stand.append(id, [{ type: "message.completed", ts: Date.now(), messageId: "old", role: "assistant", text: "Old page" }]);
  const admin = (await person(ADMIN)).hosted;
  let delayed: (() => void) | undefined;
  let hold = false;
  const member = (
    await person(MEMBER, {
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (hold && new URL(String(url)).pathname.endsWith("/events")) {
          hold = false;
          await new Promise<void>((resolve) => {
            delayed = resolve;
          });
        }
        return response;
      },
    })
  ).hosted;
  await vi.waitFor(() => expect(member.threads.holds({ thread: id })).toBe(true));
  hold = true;
  const page = member.threads.call("events.page", { runId: `hosted:${id}` });
  const refused = expect(page).rejects.toThrow("You no longer have access to this project.");
  await vi.waitFor(() => expect(delayed).toBeDefined());
  await admin.spaces.access.set({ ...target, everyone: false, memberIds: [] });
  await vi.waitFor(() => expect(member.threads.holds({ thread: id })).toBe(false));
  await admin.spaces.access.set({ ...target, everyone: true, memberIds: [] });
  await vi.waitFor(() => expect(member.threads.holds({ thread: id })).toBe(true));
  delayed!();
  await refused;
  expect((await member.threads.call("events.page", { runId: `hosted:${id}` })).events).toContainEqual(expect.objectContaining({ text: "Old page" }));
});

it("does not join or forward frames from a watch answer delayed across revoked access", async () => {
  const target = project();
  const id = stand.addThread(MEMBER, { projectId: target.projectId, title: "Delayed watch" });
  const admin = (await person(ADMIN)).hosted;
  let release: (() => void) | undefined;
  let hold = true;
  const { hosted: member, seen } = await person(MEMBER, {
    connect: (url, token) => {
      const socket = stand.connect(url, token);
      return {
        ...socket,
        ask: async (event, body) => {
          const reply = await socket.ask(event, body);
          if (hold && event === "hosted:watch" && body === id) {
            hold = false;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return reply;
        },
      };
    },
  });
  await vi.waitFor(() => expect(member.threads.holds({ thread: id })).toBe(true));
  const page = member.threads.call("events.page", { runId: `hosted:${id}` });
  const refused = expect(page).rejects.toThrow("You no longer have access to this project.");
  await vi.waitFor(() => expect(release).toBeDefined());
  await admin.spaces.access.set({ ...target, everyone: false, memberIds: [] });
  await vi.waitFor(() => expect(member.threads.holds({ thread: id })).toBe(false));
  release!();
  await refused;
  stand.append(id, [{ type: "message.completed", ts: Date.now(), messageId: "hidden", role: "assistant", text: "Not visible" }]);
  await admin.spaces.access.set({ ...target, everyone: true, memberIds: [] });
  await vi.waitFor(() => expect(member.threads.holds({ thread: id })).toBe(true));
  expect(seen.pushes.filter(isFrame)).toEqual([]);
  await member.threads.call("events.page", { runId: `hosted:${id}` });
  stand.append(id, [{ type: "message.completed", ts: Date.now(), messageId: "new", role: "assistant", text: "Visible again" }]);
  await vi.waitFor(() => expect(seen.pushes.filter(isFrame)).toHaveLength(1));
});

it("reads the account again when a spaces read finds the person's organization access changed, as a grace day ending does", async () => {
  project();
  const grace = { state: "grace", reason: "seat_removed", until: new Date(Date.now() + 3_600_000).toISOString(), message: "Your seat was taken back." } as const;
  stand.setBilling(MEMBER, { pro: true, standing: "grace", at: new Date(Date.now() + 3_600_000).toISOString(), monthlyLeftSeconds: 0, packsLeftSeconds: 0, organizationAccess: grace });
  const { hosted } = await person(MEMBER);
  await vi.waitFor(() => expect(hosted.account.status()).toMatchObject({ plan: { pro: true } }));
  // The day ends on the server with nothing pushed: only the gate's next read of the spaces can notice.
  const frozen = { state: "frozen", reason: "seat_removed", until: null, message: "Your seat was taken back, and your day of grace has ended." } as const;
  stand.setBilling(MEMBER, { pro: false, organizationAccess: frozen });
  await hosted.spaces.refresh();
  await vi.waitFor(() => expect(hosted.account.status()).toMatchObject({ plan: { pro: false } }));
});
