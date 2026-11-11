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

it("hands a closed current tab over at once to its left neighbor, folds it away, and forgets it once the fold ends", async () => {
  vi.useFakeTimers();
  const { useRouter } = await import("./router");
  useRouter.setState({ route: { view: "thread", threadId: "first" }, history: [], future: [], threadIds: [] });
  const { useThreadTabs } = await import("./thread-tabs");
  useThreadTabs.getState().openThread("second");
  const closing = useThreadTabs.getState().active!;
  useThreadTabs.getState().close(closing);
  expect(useRouter.getState().route).toEqual({ view: "thread", threadId: "first" });
  expect(useThreadTabs.getState().leaving).toEqual([closing]);
  expect(useThreadTabs.getState().tabs).toHaveLength(2);
  // Folding, it holds nothing: opening its thread again makes a new tab, and it is never saved.
  expect(JSON.parse(localStorage.getItem("openorc.threadTabs") ?? "{}").tabs).toHaveLength(1);
  useThreadTabs.getState().openThread("second");
  expect(useThreadTabs.getState().active).not.toBe(closing);
  vi.advanceTimersByTime(500);
  expect(useThreadTabs.getState().tabs.map((tab) => tab.route)).toEqual([
    { view: "thread", threadId: "first" },
    { view: "thread", threadId: "second" },
  ]);
  expect(useThreadTabs.getState().leaving).toEqual([]);
  vi.useRealTimers();
});

it("folds the last tab away while a new thread takes its place", async () => {
  vi.useFakeTimers();
  const { useRouter } = await import("./router");
  useRouter.setState({ route: { view: "thread", threadId: "only" }, history: [], future: [], threadIds: [] });
  const { useThreadTabs } = await import("./thread-tabs");
  useThreadTabs.getState().close(useThreadTabs.getState().active!);
  expect(useRouter.getState().route).toEqual({ view: "newthread" });
  vi.advanceTimersByTime(500);
  expect(useThreadTabs.getState().tabs.map((tab) => tab.route)).toEqual([{ view: "newthread" }]);
  vi.useRealTimers();
});

it("puts a dragged tab ahead of another or last, without leaving the open thread, and saves the order", async () => {
  const { useRouter } = await import("./router");
  useRouter.setState({ route: { view: "thread", threadId: "first" }, history: [], future: [], threadIds: [] });
  const { useThreadTabs } = await import("./thread-tabs");
  useThreadTabs.getState().openThread("second");
  useThreadTabs.getState().openThread("third");
  const threads = () => useThreadTabs.getState().tabs.map((tab) => (tab.route.view === "thread" ? tab.route.threadId : null));
  const [first, , third] = useThreadTabs.getState().tabs.map((tab) => tab.id) as [string, string, string];
  useThreadTabs.getState().reorder(third, first);
  expect(threads()).toEqual(["third", "first", "second"]);
  useThreadTabs.getState().reorder(first, null);
  expect(threads()).toEqual(["third", "second", "first"]);
  expect(useThreadTabs.getState().active).toBe(third);
  expect(useRouter.getState().route).toEqual({ view: "thread", threadId: "third" });
  expect(JSON.parse(localStorage.getItem("openorc.threadTabs")!).tabs.map((tab: { route: { threadId: string } }) => tab.route.threadId)).toEqual(["third", "second", "first"]);
});
