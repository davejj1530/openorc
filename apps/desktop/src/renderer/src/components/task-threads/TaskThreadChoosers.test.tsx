import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Project, Task, ThreadChoice, ThreadSummary } from "@openorc/protocol";
import { useRpcMutation } from "../../lib/client";
import * as router from "../../lib/router";
import { accounts, api, calls, enabledAccount, models, opus, wrap } from "../test-fixtures/task-choices";
import { ContinueThreadChooser, OpenThreadChooser as Chooser } from "./TaskThreadChoosers";
import { ThreadChoiceFields } from "./ThreadChoiceFields";

const project = { id: "project", name: "openorc", settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc", detectedConfigs: [] } } as unknown as Project;
const task = { id: "task", projectId: "project", title: "Edit labels as chips", threadId: "creator", executionThreadId: null } as Task;
const creator = { id: "creator", agent: "codex", model: "gpt-test", effort: "high", claudeAccountId: null } as ThreadSummary;
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
const model = (sheet: HTMLElement) => within(sheet).getByRole<HTMLSelectElement>("combobox", { name: "Model" });

/** The arrow as the task page gives it the page's own `tasks.openThread`. */
function OpenThreadChooser(props: Omit<ComponentProps<typeof Chooser>, "open">) {
  const open = useRpcMutation("tasks.openThread");
  return <Chooser {...props} open={open.mutateAsync} />;
}

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

it("continues by asking for nothing when the current thread's model and account are kept", async () => {
  const current = { id: "current", agent: "claude", model: "opus-test", effort: "high", claudeAccountId: "personal" } as ThreadSummary;
  wrap(<ContinueThreadChooser task={{ ...task, executionThreadId: "current" }} thread={current} project={project} beforeOpen={beforeOpen} />);
  fireEvent.click(screen.getByRole("button", { name: "Continue in a new thread" }));
  const sheet = await screen.findByRole("dialog", { name: "Continue in a new thread" });
  expect((await enabledAccount(within(sheet))).value).toBe("personal");
  fireEvent.click(within(sheet).getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(calls("tasks.newThread")).toEqual([{ taskId: "task" }]));
});

it("asks for the model shown when it stands in for an inherited one whose agent is signed out here", async () => {
  availability = [
    { id: "codex", state: "sign_in" },
    { id: "claude", state: "ready" },
  ];
  const onOpus = { agent: "claude", model: "opus-test", effort: "high" };
  wrap(<OpenThreadChooser task={task} project={project} runs={[]} beforeOpen={beforeOpen} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose model for the new thread" }));
  let sheet = await screen.findByRole("dialog", { name: "Open thread" });
  await waitFor(() => expect(model(sheet).value).toBe(opus));
  fireEvent.click(within(sheet).getByRole("button", { name: "Open thread" }));
  await waitFor(() => expect(calls("tasks.openThread")).toEqual([{ taskId: "task", choice: onOpus }]));
  cleanup();

  wrap(<ContinueThreadChooser task={{ ...task, executionThreadId: "current" }} thread={{ ...creator, id: "current" }} project={project} beforeOpen={beforeOpen} />);
  fireEvent.click(screen.getByRole("button", { name: "Continue in a new thread" }));
  sheet = await screen.findByRole("dialog", { name: "Continue in a new thread" });
  await waitFor(() => expect(model(sheet).value).toBe(opus));
  fireEvent.click(within(sheet).getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(calls("tasks.newThread")).toEqual([{ taskId: "task", choice: onOpus }]));
});

it("clears the choice for Default, and drops the account when the model moves to another agent", async () => {
  const onChange = vi.fn<(choice: ThreadChoice | undefined) => void>();
  const chosen: ThreadChoice = { agent: "claude", model: "opus-test", effort: "high", claudeAccountId: "personal" };
  wrap(<ThreadChoiceFields value={chosen} onChange={onChange} project={project} sameLabel="Default" layout="card" />);
  const field = screen.getByRole<HTMLSelectElement>("combobox", { name: "Model" });
  await waitFor(() => expect(within(field).getAllByRole("option")).toHaveLength(3));
  fireEvent.change(field, { target: { value: "" } });
  expect(onChange).toHaveBeenLastCalledWith(undefined);
  fireEvent.change(field, { target: { value: JSON.stringify(["codex", "gpt-test", "high"]) } });
  expect(onChange).toHaveBeenLastCalledWith({ agent: "codex", model: "gpt-test", effort: "high" });
});
