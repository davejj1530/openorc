import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { SpacesStatus } from "@openorc/protocol";
import { OrganizationAccessStore } from "./organization-access-store";
import { TeamChatDrafts } from "./team-chat-draft";
import { TeamChatClosedGroups } from "./team-chat-closed-groups";
import { TeamChatProtection } from "./team-chat-protection";
import { spaceNavigation } from "./space-navigation";

const target = { accountId: "self", spaceId: "team", conversationId: "general" };
const other = { ...target, spaceId: "other" };
const group = { id: "group", kind: "dm" as const, lastMessageSeq: 4, participants: ["self", "one", "two"].map((id) => ({ person: { id, name: id, image: null }, inOrganization: true })) };
function status(): Extract<SpacesStatus, { state: "ready" }> {
  return {
    state: "ready",
    userId: "self",
    apiOrigin: "https://example.com",
    personalSpaceId: "personal",
    spaces: [
      { id: "personal", kind: "personal" },
      ...["team", "other"].map((id) => ({ id, kind: "organization" as const, name: id, logo: null, memberId: id, role: "member" as const, memberCount: 2 })),
    ],
    reach: "live",
    heardAt: Date.now(),
    error: null,
    invitations: [],
    create: { allowed: true, reason: null },
    organizationAccess: { state: "active", reason: null, until: null, message: null },
  };
}
const stops: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  spaceNavigation.setState({ key: "account", current: "team" });
});
afterEach(() => {
  stops
    .splice(0)
    .reverse()
    .forEach((stop) => stop());
  localStorage.clear();
  vi.useRealTimers();
});
async function fixture() {
  let answer = status();
  const gate = new OrganizationAccessStore({ now: Date.now, read: async () => answer });
  const queries = new QueryClient();
  const drafts = new TeamChatDrafts(localStorage);
  const closedGroups = new TeamChatClosedGroups(localStorage);
  const protection = new TeamChatProtection({ gate, queries, drafts, closedGroups, navigation: spaceNavigation });
  stops.push(
    () => gate.dispose(),
    () => queries.clear(),
    protection.connect(),
  );
  await gate.refresh();
  const scope = protection.scope(answer, "team")!;
  queries.setQueryData(["team-chat", "self", "team", scope.generation, "timeline"], "Private history");
  drafts.write(target, "Keep through a frozen seat");
  drafts.write(other, "Other team draft");
  closedGroups.close(target, group);
  closedGroups.close(other, group);
  return {
    gate,
    queries,
    drafts,
    closedGroups,
    scope,
    protection,
    answer: (next: typeof answer) => {
      answer = next;
    },
  };
}

it("closes cached history before rendering at the offline grace deadline and preserves drafts", async () => {
  const f = await fixture();
  f.answer({
    ...status(),
    reach: "offline",
    organizationAccess: { state: "grace", reason: "seat_removed", until: 2000, message: "Your seat was taken back; you have one day to get Pro to keep using organizations." },
  });
  await f.gate.refresh();
  let cachedAtClosure = -1;
  f.gate.subscribe(() => {
    if (!f.gate.status("team").allowed) cachedAtClosure = f.queries.getQueryCache().getAll().length;
  });
  vi.advanceTimersByTime(1000);
  expect(cachedAtClosure).toBe(0);
  expect(f.scope.current()).toBe(false);
  expect(f.drafts.read(target).text).toBe("Keep through a frozen seat");
  expect(f.closedGroups.isClosed(target, group)).toBe(true);
  f.answer(status());
  await f.gate.refresh();
  expect(f.protection.scope(status(), "team")?.current()).toBe(true);
  expect(f.scope.current()).toBe(false);
});

it("fences a round trip to another space without throwing away either draft", async () => {
  const f = await fixture();
  spaceNavigation.setState({ current: "other" });
  spaceNavigation.setState({ current: "team" });
  expect(f.scope.current()).toBe(false);
  expect(f.queries.getQueryCache().getAll()).toEqual([]);
  expect(f.drafts.read(target).text).toBe("Keep through a frozen seat");
  expect(f.drafts.read(other).text).toBe("Other team draft");
});

it("forgets only a removed membership's drafts and clears protected history", async () => {
  const f = await fixture();
  const fresh = status();
  f.answer({ ...fresh, spaces: fresh.spaces.filter((space) => space.id !== "team") });
  await f.gate.refresh();
  expect(f.drafts.read(target).text).toBe("");
  expect(f.closedGroups.isClosed(target, group)).toBe(false);
  expect(f.closedGroups.isClosed(other, group)).toBe(true);
  expect(f.drafts.read(other).text).toBe("Other team draft");
  expect(f.queries.getQueryCache().getAll()).toEqual([]);
  expect(f.scope.current()).toBe(false);
});

it("closes the previous account without letting a late reply enter the next account", async () => {
  const f = await fixture();
  const next = { ...status(), userId: "second" };
  f.drafts.write({ ...target, accountId: "second" }, "The next account's words");
  f.protection.subscribe(() => f.protection.scope(next, "team"));
  f.answer(next);
  await f.gate.refresh();
  expect(f.drafts.read(target).text).toBe("");
  expect(f.queries.getQueryCache().getAll()).toEqual([]);
  expect(f.scope.current()).toBe(false);
  expect(f.drafts.read({ ...target, accountId: "second" }).text).toBe("The next account's words");
  expect(f.protection.scope(status(), "team")).toBeNull();
});
