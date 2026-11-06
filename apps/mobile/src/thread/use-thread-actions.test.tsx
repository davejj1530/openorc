// @vitest-environment jsdom
import type { RpcMethod, RpcParams } from "@openorc/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { router } from "expo-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fixtureThreads } from "../home/test-fixtures/threads";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { alerts } from "../test-fixtures/react-native";
import { opened } from "../test-fixtures/web-browser";
import { threadMenu, threadSwipes, type ThreadAction } from "./thread-actions";
import { useThreadActions } from "./use-thread-actions";

vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
const mac = vi.hoisted(() => ({
  phone: null as FakeMac | null,
  updates: [] as RpcParams<"threads.update">[],
  refuse: null as string | null,
  moves: [] as { host: string | null; method: string; params: unknown }[],
  asked: null as string | null,
}));
vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method: RpcMethod, params) => {
    if (method.startsWith("cloud.")) {
      mac.moves.push({ host: mac.asked, method, params });
      return mac.refuse ? Promise.reject(new Error(mac.refuse)) : Promise.resolve(null);
    }
    if (method !== "threads.update") return Promise.resolve(null);
    mac.updates.push(params as RpcParams<"threads.update">);
    return mac.refuse ? Promise.reject(new Error(mac.refuse)) : Promise.resolve(null);
  });
  const { hostLink } = mac.phone.module;
  return {
    ...mac.phone.module,
    hostLink: (host: string | null) => {
      mac.asked = host;
      return hostLink();
    },
  };
});

beforeEach(() => {
  mac.updates.length = 0;
  mac.moves.length = 0;
  mac.refuse = null;
  alerts.length = 0;
  opened.length = 0;
  vi.mocked(router.push).mockClear();
});
afterEach(cleanup);

const plan = fixtureThreads.find((thread) => thread.id === "t-plan")!;
/** The fixtures' own clock, so their threads are as recent as they were written. */
const fixtureNow = Date.UTC(2026, 9, 23, 12);
const settings = fixtureThreads.find((thread) => thread.id === "t-settings")!;
const find = (sections: ThreadAction[][], label: string) => sections.flat().find((action) => action.label === label)!;
const snoozeItem = (sections: ThreadAction[][], label: string) => {
  const snooze = find(sections, "Snooze");
  return snooze.kind === "menu" ? snooze.actions.find((action) => action.label === label)! : snooze;
};

it("sends each menu change to the Mac as the thread's patch", async () => {
  const onUnread = vi.fn();
  const { result } = renderHook(() => useThreadActions(plan, { onUnread }), { wrapper: mac.phone!.wrapper });
  const menu = threadMenu(plan, "header", new Date(fixtureNow));
  for (const label of ["Pin", "Resolve", "Mark as Unread"]) act(() => result.current.run(find(menu, label)));
  act(() => result.current.run(snoozeItem(menu, "In 1 hour")));
  await waitFor(() => expect(mac.updates).toHaveLength(4));
  expect(mac.updates.map((update) => update.patch)).toEqual([{ pinned: true }, { archived: true }, { seen: false }, { snoozedUntil: expect.any(Number) }]);
  expect(mac.updates.every((update) => update.id === "t-plan")).toBe(true);
  expect(onUnread).toHaveBeenCalledOnce();
});

it("snoozes from when the item is chosen, though the row's menu was built hours before", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 21, 9) });
  try {
    const menu = threadMenu(plan, "row", new Date());
    vi.setSystemTime(new Date(2026, 9, 21, 12));
    const { result } = renderHook(() => useThreadActions(plan), { wrapper: mac.phone!.wrapper });
    act(() => result.current.run(snoozeItem(menu, "In 1 hour")));
    await waitFor(() => expect(mac.updates).toHaveLength(1));
    expect(mac.updates[0]!.patch).toEqual({ snoozedUntil: new Date(2026, 9, 21, 13).getTime() });
  } finally {
    vi.useRealTimers();
  }
});

it("snoozes This evening from a menu built at five and tapped at half past six until the next morning, never to a time gone by", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 21, 17) });
  try {
    const menu = threadMenu(plan, "row", new Date());
    vi.setSystemTime(new Date(2026, 9, 21, 18, 30));
    const { result } = renderHook(() => useThreadActions(plan), { wrapper: mac.phone!.wrapper });
    act(() => result.current.run(snoozeItem(menu, "This evening")));
    await waitFor(() => expect(mac.updates).toHaveLength(1));
    expect(mac.updates[0]!.patch).toEqual({ snoozedUntil: new Date(2026, 9, 22, 9).getTime() });
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the same actions while the thread is the same, so the header's native menu is not set again each render", () => {
  const { result, rerender } = renderHook(({ thread }) => useThreadActions(thread), { wrapper: mac.phone!.wrapper, initialProps: { thread: plan } });
  const first = result.current.run;
  rerender({ thread: plan });
  expect(result.current.run).toBe(first);
  rerender({ thread: { ...plan, unread: true } });
  expect(result.current.run).not.toBe(first);
});

it("renames from a prompt with the title in it, saving only a real change", async () => {
  const { result } = renderHook(() => useThreadActions(plan), { wrapper: mac.phone!.wrapper });
  act(() => result.current.run(find(threadMenu(plan, "row", new Date()), "Rename…")));
  expect(alerts[0]).toMatchObject({ title: "Rename Thread", defaultValue: "Plan the week" });
  const save = alerts[0]!.buttons!.find((button) => button.text === "Save")!;
  act(() => save.onPress!("  Plan the week "));
  act(() => save.onPress!("   "));
  act(() => save.onPress!(" Plan next week "));
  await waitFor(() => expect(mac.updates).toHaveLength(1));
  expect(mac.updates[0]!.patch).toEqual({ title: "Plan next week" });
});

it("opens the pull request in Safari over the app", () => {
  const { result } = renderHook(() => useThreadActions(settings), { wrapper: mac.phone!.wrapper });
  act(() => result.current.run(find(threadMenu(settings, "row", new Date()), "Open Pull Request")));
  expect(opened).toEqual(["https://github.com/me/openorc/pull/471"]);
  expect(mac.updates).toEqual([]);
});

it("opens the thread's Changes and Preview from the header's menu", () => {
  const { result } = renderHook(() => useThreadActions(settings), { wrapper: mac.phone!.wrapper });
  const menu = threadMenu(settings, "header", new Date(), { uncommitted: 3, preview: { page: null } });
  act(() => result.current.run(find(menu, "Changes")));
  act(() => result.current.run(find(menu, "Preview")));
  expect(vi.mocked(router.push).mock.calls).toEqual([[{ pathname: "/changes", params: { threadId: "t-settings" } }], [{ pathname: "/preview", params: { threadId: "t-settings" } }]]);
  expect(mac.updates).toEqual([]);
});

it("asks the group's Mac to bring a cloud brain thread home, and says why when it cannot", async () => {
  const onBrain = { ...settings, activity: "idle" as const };
  const { result } = renderHook(() => useThreadActions(onBrain), { wrapper: mac.phone!.wrapper });
  const bring = find(threadMenu(onBrain, "header", new Date(), { uncommitted: null, preview: null, moves: { mac: "mac-1", onBrain: true } }), "Bring to Mac");
  act(() => result.current.run(bring));
  await waitFor(() => expect(mac.moves).toEqual([{ host: "mac-1", method: "cloud.bringToMac", params: { threadId: "t-settings" } }]));
  mac.refuse = "This conversation is already moving.";
  act(() => result.current.run(bring));
  await waitFor(() => expect(alerts.at(-1)).toMatchObject({ title: "Couldn’t move this thread", message: "This conversation is already moving." }));
  expect(mac.updates).toEqual([]);
});

it("says why when the Mac refuses a change", async () => {
  mac.refuse = "The team is still working.";
  const { result } = renderHook(() => useThreadActions(plan), { wrapper: mac.phone!.wrapper });
  act(() => result.current.save(threadSwipes(plan, fixtureNow).trailing!.patch));
  await waitFor(() => expect(alerts).toHaveLength(1));
  expect(alerts[0]).toMatchObject({ title: "Couldn’t change this thread", message: "The team is still working." });
});

it("swipes mark read or unread and resolve or reopen, and leave a team thread's to the Mac", () => {
  expect(threadSwipes(plan, fixtureNow)).toEqual({ leading: { label: "Unread", patch: { seen: false } }, trailing: { label: "Resolve", patch: { archived: true } } });
  // Quiet for over a week, a thread is resolved by its age.
  expect(threadSwipes(plan, fixtureNow + 10 * 86_400_000).trailing).toEqual({ label: "Reopen", patch: { archived: false } });
  const slack = fixtureThreads.find((thread) => thread.id === "t-slack")!;
  expect(threadSwipes({ ...slack, archivedAt: 1 }, fixtureNow)).toEqual({ leading: { label: "Read", patch: { seen: true } }, trailing: { label: "Reopen", patch: { archived: false } } });
  expect(threadSwipes({ ...plan, teamInstanceId: "team" }).trailing).toBeNull();
});
