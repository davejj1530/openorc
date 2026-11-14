import { QueryClient } from "@tanstack/react-query";
import type { OrganizationAccess, SpacesStatus } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { OrganizationAccessStore } from "./organization-access-store";
import { protectTaskCache, readTaskContent } from "./task-access-cache";

const active: OrganizationAccess = { state: "active", reason: null, until: null, message: null };
const frozen: OrganizationAccess = { state: "frozen", reason: "seat_removed", until: null, message: "Your day of grace has ended." };
const scope = { accountId: "account-a", spaceId: "team-a" };
const draftKey = (space: string) => `openorc.draft.task.online:${JSON.stringify(["account-a", space, "project-a", "task-a"])}`;
const conversationKey = (space: string) => `openorc.draft.conversation.online:${JSON.stringify(["account-a", space, "thread-a", "https://example.com"])}`;
const stops: (() => void)[] = [];
afterEach(() => {
  stops
    .splice(0)
    .reverse()
    .forEach((stop) => stop());
  localStorage.clear();
});
it("retains a prepared conversation on freeze and removes its words and file references on departure", async () => {
  const f = await fixture();
  const key = conversationKey("team-a");
  localStorage.setItem(key, "Own draft words");
  localStorage.setItem(`${key}.attachments`, "Own file references");
  await f.change(frozen);
  expect(localStorage.getItem(key)).toBe("Own draft words");
  await f.change(
    active,
    f.gate.getSnapshot().spaces.filter((space) => space.id !== "team-a"),
  );
  expect(localStorage.getItem(key)).toBeNull();
  expect(localStorage.getItem(`${key}.attachments`)).toBeNull();
});
async function fixture() {
  let status: Extract<SpacesStatus, { state: "ready" }> = {
    state: "ready",
    apiOrigin: "https://example.com",
    userId: "account-a",
    personalSpaceId: "personal-a",
    spaces: ["team-a", "team-b"].map((id) => ({ id, kind: "organization", name: id, logo: null, memberId: id + "-member", role: "member", memberCount: 2 })),
    create: { allowed: true, reason: null },
    invitations: [],
    reach: "live",
    heardAt: 1000,
    error: null,
    organizationAccess: active,
  };
  const gate = new OrganizationAccessStore({ now: () => 1000, read: async () => status });
  const client = new QueryClient();
  stops.push(
    () => gate.dispose(),
    () => client.clear(),
    protectTaskCache(gate, client, localStorage),
  );
  await gate.refresh();
  return {
    gate,
    client,
    change: async (access: OrganizationAccess, spaces = status.spaces, userId = "account-a") => {
      status = { ...status, organizationAccess: access, spaces, userId };
      await gate.refresh();
    },
  };
}

it("clears protected tasks and people before rendering a freeze, while keeping private drafts and Mac queries", async () => {
  const f = await fixture();
  const online = ["online-tasks", "account-a", "team-a", "list"];
  const roster = ["online-tasks", "account-a", "team-b", "assignees"];
  f.client.setQueryData(online, { title: "Protected task" });
  f.client.setQueryData(roster, { name: "Protected person" });
  f.client.setQueryData(["tasks.list"], ["Private Mac task"]);
  localStorage.setItem(draftKey("team-a"), "My unsaved words");
  f.gate.subscribe(() => expect(f.client.getQueryData(online)).toBeUndefined());
  await f.change(frozen);
  expect(f.client.getQueryData(roster)).toBeUndefined();
  expect(f.client.getQueryData(["tasks.list"])).toEqual(["Private Mac task"]);
  expect(localStorage.getItem(draftKey("team-a"))).toBe("My unsaved words");
});

it("removes drafts only for a departed membership, and all old-account drafts on account change", async () => {
  const f = await fixture();
  localStorage.setItem(draftKey("team-a"), "Draft A");
  localStorage.setItem(draftKey("team-b"), "Draft B");
  await f.change(
    active,
    f.gate.getSnapshot().spaces.filter((space) => space.id !== "team-a"),
  );
  expect(localStorage.getItem(draftKey("team-a"))).toBeNull();
  expect(localStorage.getItem(draftKey("team-b"))).toBe("Draft B");
  await f.change(active, [...f.gate.getSnapshot().spaces], "account-b");
  expect(localStorage.getItem(draftKey("team-b"))).toBeNull();
});

it("rejects a delayed reply across freeze and recovery and starts no request while frozen", async () => {
  const f = await fixture();
  let resolve: (value: string) => void = () => {};
  const pending = readTaskContent(
    f.gate,
    scope,
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  const rejected = expect(pending).rejects.toThrow("access changed");
  await f.change(frozen);
  const read = vi.fn(async () => "Secret");
  await expect(readTaskContent(f.gate, scope, read)).rejects.toThrow("access changed");
  expect(read).not.toHaveBeenCalled();
  await f.change(active);
  resolve("Old protected content");
  await rejected;
});

it("rejects an old account's callback before it sends even when both accounts can use the same space", async () => {
  const f = await fixture();
  await f.change(active, [...f.gate.getSnapshot().spaces], "account-b");
  const send = vi.fn(async () => "Changed task");
  await expect(readTaskContent(f.gate, scope, send)).rejects.toThrow("access changed");
  expect(send).not.toHaveBeenCalled();
});
