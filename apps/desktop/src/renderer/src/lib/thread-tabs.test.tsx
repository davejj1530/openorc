import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

it("opens a thread in a tab of its own beside the current one, and goes back to that tab when it is asked for again", async () => {
  const { useRouter } = await import("./router");
  useRouter.setState({ route: { view: "thread", threadId: "first" }, history: [], future: [], threadIds: [] });
  const { useThreadTabs } = await import("./thread-tabs");
  const opening = useThreadTabs.getState().active;
  useThreadTabs.getState().openThread("second");
  const { tabs, active } = useThreadTabs.getState();
  expect(tabs.map((tab) => tab.route)).toEqual([
    { view: "thread", threadId: "first" },
    { view: "thread", threadId: "second" },
  ]);
  expect(active).not.toBe(opening);
  expect(useRouter.getState().route).toEqual({ view: "thread", threadId: "second" });
  useThreadTabs.getState().select(opening!);
  useThreadTabs.getState().openThread("second");
  expect(useThreadTabs.getState().tabs).toHaveLength(2);
  expect(useRouter.getState().route).toEqual({ view: "thread", threadId: "second" });
});

it("never writes one tab's place into another when going back", async () => {
  const { useRouter } = await import("./router");
  useRouter.setState({ route: { view: "thread", threadId: "first" }, history: [], future: [], threadIds: [] });
  const { useThreadTabs } = await import("./thread-tabs");
  const first = useThreadTabs.getState().active!;
  useThreadTabs.getState().open("studio");
  useThreadTabs.getState().select(first);
  useRouter.getState().back();
  expect(useThreadTabs.getState().tabs.map((tab) => tab.route)).toEqual([
    { view: "thread", threadId: "first" },
    { view: "newthread", projectId: "studio" },
  ]);
});

it("brings back a project's new thread rather than opening a second one", async () => {
  const { useRouter } = await import("./router");
  useRouter.setState({ route: { view: "thread", threadId: "first" }, history: [], future: [], threadIds: [] });
  const { useThreadTabs } = await import("./thread-tabs");
  useThreadTabs.getState().open("studio");
  const fresh = useThreadTabs.getState().active;
  useThreadTabs.getState().openThread("second");
  useThreadTabs.getState().open("studio");
  expect(useThreadTabs.getState().tabs).toHaveLength(3);
  expect(useThreadTabs.getState().active).toBe(fresh);
});

it("keeps the leftmost pane's thread in the tab while another pane of a split is focused", async () => {
  const { useRouter } = await import("./router");
  useRouter.setState({ route: { view: "thread", threadId: "first" }, history: [], future: [], threadIds: ["first"] });
  const { useThreadTabs } = await import("./thread-tabs");
  useRouter.getState().addThreadPane("second");
  useRouter.getState().focusThreadPane("second");
  expect(useThreadTabs.getState().tabs.map((tab) => tab.route)).toEqual([{ view: "thread", threadId: "first" }]);
});

it("restores the open tab without a step to go back over", async () => {
  localStorage.setItem("openorc.threadTabs", JSON.stringify({ tabs: [{ id: "a", route: { view: "thread", threadId: "kept" } }], active: "a" }));
  const { useRouter } = await import("./router");
  await import("./thread-tabs");
  expect(useRouter.getState().route).toEqual({ view: "thread", threadId: "kept" });
  expect(useRouter.getState().history).toEqual([]);
});
