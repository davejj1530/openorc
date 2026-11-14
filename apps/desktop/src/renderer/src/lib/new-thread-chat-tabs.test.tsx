import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";

const chat = { view: "team-chat" as const, accountId: "account", spaceId: "team", conversationId: "general" };
const prepared = [
  { name: "a pristine placeholder", project: "", words: "", file: false },
  { name: "words", project: "", words: "Keep this draft", file: false },
  { name: "a file", project: "", words: "", file: true },
  { name: "a chosen project", project: "studio", words: "", file: false },
];

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.resetModules();
});

async function setup(row: (typeof prepared)[number]) {
  const route = { view: "newthread" as const, ...(row.project && { projectId: row.project }) };
  if (row.file) localStorage.setItem(`openorc.draft.newthread.${row.project}.attachments`, JSON.stringify({ attachments: [{ path: "/tmp/example.txt", name: "example.txt", url: null }] }));
  const { useNewThreadPreparation } = await import("./new-thread-preparation");
  renderHook(() => useNewThreadPreparation(row.project, row.words));
  const { useRouter } = await import("./router");
  useRouter.setState({ route, history: [], future: [], threadIds: [] });
  const { useThreadTabs } = await import("./thread-tabs");
  return { route, router: useRouter, tabs: useThreadTabs };
}

it.each(prepared)("ordinary thread opening keeps its current behavior with $name", async (row) => {
  const { router, tabs } = await setup(row);
  const original = tabs.getState().active;
  router.getState().navigate({ view: "thread", threadId: "existing" });
  expect(tabs.getState().tabs).toEqual([{ id: original, route: { view: "thread", threadId: "existing" } }]);
});

it.each(prepared)("chat takes over only an unprepared New thread with $name", async (row) => {
  const { route, router, tabs } = await setup(row);
  const original = tabs.getState().active;
  router.getState().navigate(chat);
  const pristine = !row.project && !row.words && !row.file;
  expect(tabs.getState().tabs.map((tab) => tab.route)).toEqual(pristine ? [chat] : [route, chat]);
  expect(tabs.getState().active === original).toBe(pristine);
});
