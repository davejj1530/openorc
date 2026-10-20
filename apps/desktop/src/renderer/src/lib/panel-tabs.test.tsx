import { beforeEach, expect, it } from "vitest";
import { activeTab, currentPage, newPanelSession, usePanelSessions, type PanelPage } from "./panel-tabs";

const scope = "thread:one";
const changes: PanelPage = { kind: "changes", selection: null };
const terminal: PanelPage = { kind: "tool", tool: "terminal" };
const session = () => usePanelSessions.getState().sessions[scope] ?? newPanelSession(scope);
const actions = () => usePanelSessions.getState();

beforeEach(() => usePanelSessions.setState({ sessions: {} }));

it("starts with one new tab and opens a tool in that tab", () => {
  expect(session().tabs).toHaveLength(1);
  expect(currentPage(activeTab(session()))).toEqual({ kind: "newtab" });
  actions().navigate(scope, changes);
  expect(session().tabs).toHaveLength(1);
  expect(currentPage(activeTab(session()))).toEqual(changes);
  actions().move(scope, -1);
  expect(currentPage(activeTab(session()))).toEqual({ kind: "newtab" });
  actions().move(scope, 1);
  expect(currentPage(activeTab(session()))).toEqual(changes);
});

it("keeps multiple tabs and each conversation's history independent", () => {
  actions().navigate(scope, changes);
  const first = session().activeId;
  actions().add(scope);
  actions().navigate(scope, terminal);
  const second = session().activeId;
  actions().navigate("thread:two", { kind: "tool", tool: "memory" });
  actions().select(scope, first);
  expect(currentPage(activeTab(session()))).toEqual(changes);
  actions().select(scope, second);
  expect(currentPage(activeTab(session()))).toEqual(terminal);
  expect(session().tabs).toHaveLength(2);
});

it("selects an adjacent tab on close and replaces the last tab with a new tab", () => {
  actions().navigate(scope, terminal);
  actions().add(scope);
  actions().navigate(scope, changes);
  actions().close(scope, session().activeId);
  expect(currentPage(activeTab(session()))).toEqual(terminal);
  actions().close(scope, session().activeId);
  expect(session().tabs).toHaveLength(1);
  expect(currentPage(activeTab(session()))).toEqual({ kind: "newtab" });
});

it("reuses the requested tool without duplicating its history or another tab", () => {
  actions().open(scope, changes);
  actions().add(scope);
  actions().open(scope, changes);
  expect(session().tabs).toHaveLength(2);
  expect(activeTab(session()).entries).toHaveLength(2);
  expect(session().activeId).toBe(scope);
});

it("keeps each opened file's selection and discards forward history after navigation", () => {
  const first: PanelPage = { kind: "file", selection: { path: "first.ts", scope: { kind: "thread", id: "one" } } };
  const second: PanelPage = { kind: "file", selection: { path: "second.ts", scope: { kind: "thread", id: "one" } } };
  actions().open(scope, first);
  actions().open(scope, second);
  expect(session().tabs).toHaveLength(2);
  actions().move(scope, -1);
  actions().navigate(scope, terminal);
  actions().move(scope, 1);
  expect(currentPage(activeTab(session()))).toEqual(terminal);
  expect(currentPage(session().tabs[0])).toEqual(first);
});

it("restores the agent's native preview tab and updates only that page's title", () => {
  actions().navigate(scope, changes);
  actions().add(scope);
  const second = session().activeId;
  actions().open(scope, { kind: "browser", url: "", title: "" }, second);
  actions().reportBrowser(scope, second, "https://example.com", "Example");
  actions().select(scope, scope);
  expect(currentPage(activeTab(session()))).toEqual(changes);
  actions().select(scope, second);
  expect(currentPage(activeTab(session()))).toEqual({ kind: "browser", url: "https://example.com", title: "Example" });
  expect(JSON.parse(localStorage.getItem("openorc.panel-sessions") ?? "{}").state.sessions[scope].tabs).toHaveLength(2);
});

it("opens Changes at the front of the track, and it closes like any tab", () => {
  actions().open(scope, terminal);
  actions().open(scope, { kind: "tool", tool: "memory" });
  actions().open(scope, changes);
  expect(session().tabs.map((tab) => currentPage(tab))).toEqual([changes, terminal, { kind: "tool", tool: "memory" }]);
  expect(currentPage(activeTab(session()))).toEqual(changes);
  actions().close(scope, session().activeId);
  expect(session().tabs.map((tab) => currentPage(tab))).toEqual([terminal, { kind: "tool", tool: "memory" }]);
});

it("moves a blank tab that opens Changes to the front", () => {
  actions().open(scope, terminal);
  actions().add(scope);
  actions().open(scope, changes);
  expect(session().tabs).toHaveLength(2);
  expect(currentPage(session().tabs[0])).toEqual(changes);
  expect(session().activeId).toBe(session().tabs[0].id);
});

it("restores a saved session in its saved order and leaves Changes alone on an agent reveal", () => {
  const saved = {
    tabs: [
      { id: "b", entries: [terminal], index: 0 },
      { id: "a", entries: [changes], index: 0 },
    ],
    activeId: "b",
  } as const;
  usePanelSessions.setState({ sessions: { [scope]: structuredClone(saved) as never } });
  expect(session().tabs.map((tab) => tab.id)).toEqual(["b", "a"]);
  actions().open(scope, { kind: "browser", url: "", title: "" }, scope);
  expect(session().tabs.map((tab) => tab.id)).toEqual(["b", "a", scope]);
  expect(currentPage(session().tabs[1]!)).toEqual(changes);
});
