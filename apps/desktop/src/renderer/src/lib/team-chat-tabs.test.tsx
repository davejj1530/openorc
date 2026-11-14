import { afterEach, expect, it, vi } from "vitest";

const chat = { view: "team-chat" as const, accountId: "account", spaceId: "team", conversationId: "general" };
afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

it("opens chat beside work, reuses its tab, and keeps it when another work thread opens", async () => {
  const { useRouter } = await import("./router");
  useRouter.setState({ route: { view: "thread", threadId: "first" }, history: [], future: [], threadIds: ["first"] });
  const { useThreadTabs } = await import("./thread-tabs");
  useRouter.getState().navigate(chat);
  expect(useThreadTabs.getState().tabs.map((tab) => tab.route)).toEqual([{ view: "thread", threadId: "first" }, chat]);
  const order = useThreadTabs.getState().tabs.map((tab) => tab.id);
  useRouter.getState().navigate({ ...chat });
  expect(useThreadTabs.getState().tabs.map((tab) => tab.id)).toEqual(order);
  useRouter.getState().navigate({ view: "thread", threadId: "second" });
  expect(useThreadTabs.getState().tabs.map((tab) => tab.route)).toEqual([{ view: "thread", threadId: "first" }, chat, { view: "thread", threadId: "second" }]);
});
it("never restores organization chat from the unscoped Personal tab list", async () => {
  localStorage.setItem("openorc.threadTabs", JSON.stringify({ tabs: [{ id: "chat", route: chat }], active: "chat" }));
  const { useThreadTabs } = await import("./thread-tabs");
  expect(useThreadTabs.getState().tabs.some((tab) => tab.route.view === "team-chat")).toBe(false);
});
