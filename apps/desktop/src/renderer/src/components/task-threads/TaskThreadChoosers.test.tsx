import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClaudeAccounts, ModelOption, Project, Task, ThreadSummary } from "@openorc/protocol";
import { core } from "../../lib/rpc";
import * as router from "../../lib/router";
import { ContinueThreadChooser, OpenThreadChooser } from "./TaskThreadChoosers";

/** The Account field once a Claude model makes it a choice; before that it shows disabled. */
async function enabledAccount(scope: Pick<typeof screen, "getByRole">): Promise<HTMLSelectElement> {
  await waitFor(() => expect(scope.getByRole<HTMLSelectElement>("combobox", { name: "Account" }).disabled).toBe(false));
  return scope.getByRole<HTMLSelectElement>("combobox", { name: "Account" });
}

const models: ModelOption[] = [
  { id: "gpt-test", label: "GPT Test", agent: "codex", efforts: ["high"], defaultEffort: "high", isDefault: true },
  { id: "opus-test", label: "Opus Test", agent: "claude", efforts: ["high"], defaultEffort: "high", isDefault: true },
];
const account = (id: string, name: string) => ({ id, name, kind: "managed", enabled: true, createdAt: 1, status: "ready", email: null, organization: null, message: null }) as const;
const accounts: ClaudeAccounts = { accounts: [account("work", "Work"), account("personal", "Personal")], defaultId: "work" };
const project = { id: "project", name: "openorc", settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc", detectedConfigs: [] } } as unknown as Project;
const task = { id: "task", projectId: "project", title: "Edit labels as chips", threadId: "creator", executionThreadId: null } as Task;
const creator = { id: "creator", agent: "codex", model: "gpt-test", effort: "high", claudeAccountId: null } as ThreadSummary;
const opus = JSON.stringify(["claude", "opus-test", "high"]);
const api = vi.spyOn(core, "call");
const openThread = vi.spyOn(router, "openThread").mockImplementation(() => {});
const beforeOpen = vi.fn(async () => true);
let refuse: string | null = null;
let availability: { id: string; state: string }[] | null = null;
let defaultHarness: string | null = null;

beforeEach(() => {
  refuse = null;
  availability = null;
  defaultHarness = null;
  openThread.mockClear();
  beforeOpen.mockReset().mockImplementation(async () => true);
  api.mockReset().mockImplementation(async (method) => {
    if (method === "agents.models") return models as never;
    if (method === "agents.availability") return availability as never;
    if (method === "app.settings.get") return { defaultHarness } as never;
    if (method === "claude.accounts.list") return accounts as never;
    if (method === "threads.get") return creator as never;
    if (method === "tasks.openThread" || method === "tasks.newThread") {
      if (refuse) throw new Error(refuse);
      return { id: method === "tasks.openThread" ? "opened" : "fresh" } as never;
    }
    return null as never;
  });
});
afterEach(cleanup);
const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{node}</QueryClientProvider>);
const calls = (method: string) => api.mock.calls.filter(([name]) => name === method).map(([, params]) => params);
const model = (sheet: HTMLElement) => within(sheet).getByRole<HTMLSelectElement>("combobox", { name: "Model" });

it("opens a task's first thread on what it would inherit, or on the model and account chosen", async () => {
  wrap(<OpenThreadChooser task={task} project={project} runs={[]} beforeOpen={beforeOpen} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose model for the new thread" }));
  let sheet = await screen.findByRole("dialog", { name: "Open thread" });
  await waitFor(() => expect(model(sheet).value).toBe(JSON.stringify(["codex", "gpt-test", "high"])));
  expect(within(sheet).getByRole<HTMLSelectElement>("combobox", { name: "Account" }).disabled).toBe(true);
  fireEvent.click(within(sheet).getByRole("button", { name: "Open thread" }));
  await waitFor(() => expect(openThread).toHaveBeenCalledWith("opened"));
  expect(calls("tasks.openThread")).toEqual([{ taskId: "task" }]);
  const opened = api.mock.calls.findIndex(([name]) => name === "tasks.openThread");
  expect(beforeOpen.mock.invocationCallOrder[0]).toBeLessThan(api.mock.invocationCallOrder[opened]!);

  fireEvent.click(screen.getByRole("button", { name: "Choose model for the new thread" }));
  sheet = await screen.findByRole("dialog", { name: "Open thread" });
  fireEvent.change(model(sheet), { target: { value: opus } });
  const choose = await enabledAccount(within(sheet));
  expect(choose.value).toBe("");
  expect(
    within(choose)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["Default", "Work", "Personal"]);
  fireEvent.change(choose, { target: { value: "personal" } });
  refuse = "This project only uses these Claude accounts: Work.";
  fireEvent.click(within(sheet).getByRole("button", { name: "Open thread" }));
  expect(await within(sheet).findByRole("alert")).toHaveProperty("textContent", refuse);

  refuse = null;
  fireEvent.click(within(sheet).getByRole("button", { name: "Open thread" }));
  await waitFor(() => expect(calls("tasks.openThread")).toHaveLength(3));
  expect(calls("tasks.openThread")[2]).toEqual({ taskId: "task", choice: { agent: "claude", model: "opus-test", effort: "high", claudeAccountId: "personal" } });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("offers no choice once the task has a thread, which Open thread opens as it is", () => {
  wrap(<OpenThreadChooser task={{ ...task, executionThreadId: "current" }} project={project} runs={[]} beforeOpen={beforeOpen} />);
  expect(screen.queryByRole("button", { name: "Choose model for the new thread" })).toBeNull();
});

it("continues in a new thread on the current thread's model and account, or the ones chosen", async () => {
  const current = { id: "current", agent: "claude", model: "opus-test", effort: "high", claudeAccountId: "personal" } as ThreadSummary;
  wrap(<ContinueThreadChooser task={{ ...task, executionThreadId: "current" }} thread={current} project={project} beforeOpen={beforeOpen} />);
  fireEvent.click(screen.getByRole("button", { name: "Continue in a new thread" }));
  const sheet = await screen.findByRole("dialog", { name: "Continue in a new thread" });
  await waitFor(() => expect(model(sheet).value).toBe(opus));
  const choose = await enabledAccount(within(sheet));
  expect(choose.value).toBe("personal");
  fireEvent.change(choose, { target: { value: "work" } });
  fireEvent.click(within(sheet).getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(openThread).toHaveBeenCalledWith("fresh"));
  expect(calls("tasks.newThread")).toEqual([{ taskId: "task", choice: { agent: "claude", model: "opus-test", effort: "high", claudeAccountId: "work" } }]);
});

it("opens no thread when the task couldn't be saved first", async () => {
  beforeOpen.mockImplementation(async () => false);
  wrap(<OpenThreadChooser task={task} project={project} runs={[]} beforeOpen={beforeOpen} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose model for the new thread" }));
  const sheet = await screen.findByRole("dialog", { name: "Open thread" });
  await waitFor(() => expect(model(sheet).value).not.toBe(""));
  fireEvent.click(within(sheet).getByRole("button", { name: "Open thread" }));
  await waitFor(() => expect(beforeOpen).toHaveBeenCalledOnce());
  expect(calls("tasks.openThread")).toEqual([]);
  expect(openThread).not.toHaveBeenCalled();
});

it("offers only the models of agents signed in here", async () => {
  availability = [
    { id: "codex", state: "sign_in" },
    { id: "claude", state: "ready" },
  ];
  wrap(<OpenThreadChooser task={task} project={project} runs={[]} beforeOpen={beforeOpen} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose model for the new thread" }));
  const sheet = await screen.findByRole("dialog", { name: "Open thread" });
  await waitFor(() => expect(model(sheet).value).toBe(opus));
  expect(
    within(model(sheet))
      .getAllByRole("option")
      .map((option) => option.getAttribute("value")),
  ).toEqual([opus]);
});

it("starts a task with no runs and no creator thread on the person's default agent", async () => {
  availability = [
    { id: "codex", state: "ready" },
    { id: "claude", state: "ready" },
  ];
  defaultHarness = "claude";
  wrap(<OpenThreadChooser task={{ ...task, threadId: null }} project={project} runs={[]} beforeOpen={beforeOpen} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose model for the new thread" }));
  const sheet = await screen.findByRole("dialog", { name: "Open thread" });
  await waitFor(() => expect(model(sheet).value).toBe(opus));
  expect(within(model(sheet)).getAllByRole("option")).toHaveLength(2);
});
