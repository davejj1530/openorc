import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentSkill, ClaudeAccounts, ModelOption, Project, Task, TaskButton } from "@openorc/protocol";
import { core } from "../../lib/rpc";
import * as router from "../../lib/router";
import { usePromptSkills } from "./TaskButtonPrompt";
import { TaskButtonsSection } from "./TaskButtonsSection";
import { TaskFooterActions } from "./TaskFooterActions";

/** The Account field once a Claude model makes it a choice; before that it shows disabled. */
async function enabledAccount(scope: Pick<typeof screen, "getByRole">): Promise<HTMLSelectElement> {
  await waitFor(() => expect(scope.getByRole<HTMLSelectElement>("combobox", { name: "Account" }).disabled).toBe(false));
  return scope.getByRole<HTMLSelectElement>("combobox", { name: "Account" });
}

const review: TaskButton = { id: "review", label: "Review", prompt: "Review this task's changes and list any risks.", runsIn: "new", mode: "plan" };
const project = { id: "project", name: "openorc", settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc", detectedConfigs: [], taskButtons: [review] } } as unknown as Project;
const task = { id: "task", projectId: "project", title: "Edit labels as chips" } as Task;
const api = vi.spyOn(core, "call");
const openThread = vi.spyOn(router, "openThread").mockImplementation(() => {});
const openProject = vi.spyOn(router, "openProject").mockImplementation(() => {});
let failRun = false;
const models: ModelOption[] = [
  { id: "gpt-test", label: "GPT Test", agent: "codex", efforts: ["high"], defaultEffort: "high", isDefault: true },
  { id: "opus-test", label: "Opus Test", agent: "claude", efforts: ["high"], defaultEffort: "high", isDefault: true },
];
const account = (id: string, name: string) => ({ id, name, kind: "managed", enabled: true, createdAt: 1, status: "ready", email: null, organization: null, message: null }) as const;
const accounts: ClaudeAccounts = { accounts: [account("work", "Work"), account("personal", "Personal"), { ...account("old", "Old"), enabled: false }], defaultId: "work" };
const opus = JSON.stringify(["claude", "opus-test", "high"]);
const skills: AgentSkill[] = [
  { name: "say-hello", description: "Greets the person by name, then says what this project is for in one short paragraph.", source: "project", path: "/repo/.claude/skills/say-hello/SKILL.md" },
  { name: "review-mine", description: "Reviews the changes.", source: "user", path: "/home/me/.claude/skills/review-mine/SKILL.md" },
];

beforeEach(() => {
  failRun = false;
  openThread.mockClear();
  openProject.mockClear();
  api.mockReset().mockImplementation(async (method, params) => {
    if (method === "tasks.runButton") {
      if (failRun) throw new Error("Finish or stop this task's existing run before continuing in its thread.");
      return { threadId: "review-thread" } as never;
    }
    if (method === "projects.updateSettings") return { ...project, settings: { ...project.settings, ...(params as { settings: object }).settings } } as never;
    if (method === "agents.models") return models as never;
    if (method === "claude.accounts.list") return accounts as never;
    if (method === "skills.list") return skills as never;
    if (method === "app.settings.get") return { defaultHarness: "claude" } as never;
    return null as never;
  });
});
afterEach(cleanup);
const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{node}</QueryClientProvider>);
const calls = (method: string) => api.mock.calls.filter(([name]) => name === method).map(([, params]) => params);

const footer = (beforeRun: () => Promise<boolean>, shown: Partial<Task> = {}, buttons = [review]) => (
  <TaskFooterActions task={{ ...task, ...shown }} buttons={buttons} disabled={false} beforeRun={beforeRun}>
    <button type="button">Open thread</button>
  </TaskFooterActions>
);

it("saves the task, runs the button and opens the thread it ran in, or says why it couldn't beside the buttons", async () => {
  const beforeRun = vi.fn(async () => true);
  wrap(footer(beforeRun));
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  await waitFor(() => expect(openThread).toHaveBeenCalledWith("review-thread"));
  expect(calls("tasks.runButton")).toEqual([{ taskId: "task", buttonId: "review" }]);
  const started = api.mock.calls.findIndex(([name]) => name === "tasks.runButton");
  expect(beforeRun.mock.invocationCallOrder[0]).toBeLessThan(api.mock.invocationCallOrder[started]!);

  failRun = true;
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Finish or stop this task's existing run before continuing in its thread.");
  expect(alert.parentElement?.contains(screen.getByRole("button", { name: "Review" }))).toBe(true);
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  failRun = false;
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Edit task buttons" }));
  expect(openProject).toHaveBeenCalledWith("project");
});

it("runs nothing when the task couldn't be saved first", async () => {
  const beforeRun = vi.fn(async () => false);
  wrap(footer(beforeRun));
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review" }).disabled).toBe(false));
  expect(beforeRun).toHaveBeenCalledOnce();
  expect(calls("tasks.runButton")).toEqual([]);
  expect(openThread).not.toHaveBeenCalled();
});

it("starts one run however often the button is pressed while the task saves", async () => {
  let save!: (saved: boolean) => void;
  const beforeRun = vi.fn(() => new Promise<boolean>((resolve) => (save = resolve)));
  wrap(footer(beforeRun));
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  const pending = screen.getByRole<HTMLButtonElement>("button", { name: "Starting…" });
  expect(pending.disabled).toBe(true);
  fireEvent.click(pending);
  save(true);
  await waitFor(() => expect(openThread).toHaveBeenCalledWith("review-thread"));
  expect(beforeRun).toHaveBeenCalledOnce();
  expect(calls("tasks.runButton")).toHaveLength(1);
});

it("shows no buttons on an archived task, where none can run", () => {
  wrap(footer(async () => true, { status: "archived" }));
  expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
  expect(screen.getByRole("button", { name: "Open thread" })).toBeTruthy();
});

it("lists each button by what it shows, what it sends and how it runs, and removes one at once", async () => {
  wrap(<TaskButtonsSection project={project} />);
  const row = within(within(screen.getByRole("list", { name: "Task buttons" })).getAllByRole("listitem")[0]!);
  expect(row.getByText("Review")).toBeTruthy();
  expect(row.getByText("Review this task's changes and list any risks.")).toBeTruthy();
  expect(row.getByText("New thread · Plan")).toBeTruthy();
  fireEvent.click(row.getByRole("button", { name: "Remove Review button" }));
  await waitFor(() => expect(calls("projects.updateSettings")).toEqual([{ id: "project", settings: { taskButtons: [] } }]));
});

it("adds a button from a dialog once it has a label and a prompt", async () => {
  wrap(<TaskButtonsSection project={project} />);
  fireEvent.click(screen.getByRole("button", { name: "Add button" }));
  const dialog = within(await screen.findByRole("dialog", { name: "New button" }));
  const add = dialog.getByRole("button", { name: "Add button" });
  expect(add).toHaveProperty("disabled", true);
  fireEvent.change(dialog.getByRole("textbox", { name: "Label" }), { target: { value: " Start " } });
  fireEvent.change(dialog.getByRole("textbox", { name: /Prompt/ }), { target: { value: "Implement this task." } });
  fireEvent.change(dialog.getByRole("combobox", { name: /Runs in/ }), { target: { value: "task" } });
  fireEvent.change(dialog.getByRole("combobox", { name: /^Mode\b/ }), { target: { value: "trusted" } });
  expect(add).toHaveProperty("disabled", false);
  fireEvent.click(add);
  await waitFor(() => expect(calls("projects.updateSettings")).toHaveLength(1));
  const [saved] = calls("projects.updateSettings") as [{ settings: { taskButtons: TaskButton[] } }];
  expect(saved.settings.taskButtons).toEqual([review, { id: expect.any(String), label: "Start", prompt: "Implement this task.", runsIn: "task", mode: "trusted" }]);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

async function newButton(): Promise<{ dialog: ReturnType<typeof within>; prompt: HTMLTextAreaElement }> {
  wrap(<TaskButtonsSection project={project} />);
  fireEvent.click(screen.getByRole("button", { name: "Add button" }));
  const dialog = within(await screen.findByRole("dialog", { name: "New button" }));
  fireEvent.change(dialog.getByRole("textbox", { name: "Label" }), { target: { value: "Greet" } });
  return { dialog, prompt: dialog.getByRole<HTMLTextAreaElement>("textbox", { name: "Prompt" }) };
}
const savedButtons = () => (calls("projects.updateSettings")[0] as { settings: { taskButtons: TaskButton[] } }).settings.taskButtons;

it("lists the project's skills for a / word in the prompt, puts in the one picked and saves it with the button", async () => {
  const { dialog, prompt } = await newButton();
  fireEvent.change(prompt, { target: { value: "/sa" } });
  const option = await dialog.findByRole("option", { name: /^\/say-hello Greets the person/ });
  expect(option.getAttribute("aria-selected")).toBe("true");
  expect(dialog.queryByRole("option", { name: /review-mine/ })).toBeNull();
  expect(calls("skills.list")).toContainEqual({ scope: { kind: "project", id: "project" }, agent: "claude" });
  fireEvent.keyDown(prompt, { key: "Enter" });
  expect(prompt.value).toBe("/say-hello ");
  expect(dialog.queryByRole("listbox")).toBeNull();

  fireEvent.click(dialog.getByRole("button", { name: "Add button" }));
  await waitFor(() => expect(calls("projects.updateSettings")).toHaveLength(1));
  expect(savedButtons().at(-1)).toEqual({ id: expect.any(String), label: "Greet", prompt: "/say-hello", runsIn: "new", mode: "plan", skills: ["say-hello"] });
});

it("saves a skill typed the way another agent calls it as /name, and Escape closes the list without the dialog", async () => {
  const { dialog, prompt } = await newButton();
  fireEvent.change(prompt, { target: { value: "$say" } });
  await dialog.findByRole("option", { name: /^\/say-hello/ });
  fireEvent.keyDown(prompt, { key: "Escape" });
  expect(dialog.queryByRole("listbox")).toBeNull();
  expect(screen.getByRole("dialog", { name: "New button" })).toBeTruthy();

  fireEvent.change(prompt, { target: { value: "$say-hello, then list /src/app" } });
  fireEvent.click(dialog.getByRole("button", { name: "Add button" }));
  await waitFor(() => expect(calls("projects.updateSettings")).toHaveLength(1));
  expect(savedButtons().at(-1)).toMatchObject({ prompt: "/say-hello, then list /src/app", skills: ["say-hello"] });
});

it("edits a button's own model and account, or leaves them to the task's thread", async () => {
  const view = wrap(<TaskButtonsSection project={project} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Review button" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Edit button" }));
  const model = dialog.getByRole<HTMLSelectElement>("combobox", { name: "Model" });
  expect(model.selectedOptions[0]?.textContent).toBe("Default");
  expect(dialog.getByRole<HTMLSelectElement>("combobox", { name: "Account" }).disabled).toBe(true);
  await waitFor(() => expect(within(model).getAllByRole("option")).toHaveLength(3));

  fireEvent.change(model, { target: { value: opus } });
  const choose = await enabledAccount(dialog);
  expect(
    within(choose)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["Default", "Work", "Personal"]);
  fireEvent.change(choose, { target: { value: "personal" } });
  fireEvent.click(dialog.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(calls("projects.updateSettings")).toHaveLength(1));
  const choice = { agent: "claude", model: "opus-test", effort: "high", claudeAccountId: "personal" } as const;
  expect((calls("projects.updateSettings")[0] as { settings: { taskButtons: TaskButton[] } }).settings.taskButtons).toEqual([{ ...review, choice }]);

  view.unmount();
  wrap(<TaskButtonsSection project={{ ...project, settings: { ...project.settings, taskButtons: [{ ...review, choice }] } }} />);
  expect(await screen.findByText("New thread · Plan · Opus Test - High · Personal")).toBeTruthy();
});

it("can leave the task out of a button's message, and says so in its row", async () => {
  const view = wrap(<TaskButtonsSection project={project} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Review button" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Edit button" }));
  const include = dialog.getByRole<HTMLInputElement>("checkbox", { name: "Include the task" });
  expect(include.checked).toBe(true);
  fireEvent.click(include);
  fireEvent.click(dialog.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(calls("projects.updateSettings")).toHaveLength(1));
  expect((calls("projects.updateSettings")[0] as { settings: { taskButtons: TaskButton[] } }).settings.taskButtons).toEqual([{ ...review, includeTask: false }]);
  view.unmount();
  wrap(<TaskButtonsSection project={{ ...project, settings: { ...project.settings, taskButtons: [{ ...review, includeTask: false }] } }} />);
  expect(screen.getByText("New thread · Plan · Prompt only")).toBeTruthy();
});

it("sets the statuses a button shows on and whether it sends, and says so in its row", async () => {
  const view = wrap(<TaskButtonsSection project={project} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Review button" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Edit button" }));
  const send = dialog.getByRole<HTMLInputElement>("checkbox", { name: "Send right away" });
  expect(send.checked).toBe(true);
  fireEvent.click(send);
  const statuses = within(dialog.getByRole("group", { name: "Show on" }));
  expect(statuses.getAllByRole("button").map((chip) => chip.textContent)).toEqual(["Proposed", "Backlog", "In progress", "Review", "Done"]);
  expect(statuses.getAllByRole("button").every((chip) => chip.getAttribute("aria-pressed") === "true")).toBe(true);
  for (const status of ["Proposed", "Backlog", "In progress", "Done", "Review"]) fireEvent.click(statuses.getByRole("button", { name: status }));
  expect(dialog.getByText("Pick at least one status.")).toBeTruthy();
  expect(dialog.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  fireEvent.click(statuses.getByRole("button", { name: "In progress" }));
  fireEvent.click(statuses.getByRole("button", { name: "Review" }));
  fireEvent.click(dialog.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(calls("projects.updateSettings")).toHaveLength(1));
  const saved = { ...review, autoSend: false, statuses: ["in_progress", "review"] } satisfies TaskButton;
  expect((calls("projects.updateSettings")[0] as { settings: { taskButtons: TaskButton[] } }).settings.taskButtons).toEqual([saved]);
  view.unmount();
  wrap(<TaskButtonsSection project={{ ...project, settings: { ...project.settings, taskButtons: [saved] } }} />);
  expect(screen.getByText("New thread · Plan · Opens as a draft · Shown on In progress, Review")).toBeTruthy();
});

it("leaves Archived out of a button's statuses, and reads one saved only for it as shown nowhere", async () => {
  const archived = { ...review, statuses: ["archived"] } satisfies TaskButton;
  const view = wrap(<TaskButtonsSection project={{ ...project, settings: { ...project.settings, taskButtons: [archived] } }} />);
  expect(screen.getByText("New thread · Plan · Shown nowhere")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit Review button" }));
  let dialog = within(await screen.findByRole("dialog", { name: "Edit button" }));
  expect(dialog.getByText("Pick at least one status.")).toBeTruthy();
  expect(dialog.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  view.unmount();

  wrap(<TaskButtonsSection project={{ ...project, settings: { ...project.settings, taskButtons: [{ ...review, statuses: ["review", "archived"] }] } }} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Review button" }));
  dialog = within(await screen.findByRole("dialog", { name: "Edit button" }));
  fireEvent.click(dialog.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(calls("projects.updateSettings")).toHaveLength(1));
  expect(savedButtons()).toEqual([{ ...review, statuses: ["review"] }]);
});

it("shows a button only on its statuses, and adds an unsent message to what the thread's box has", async () => {
  const unsent: TaskButton = { ...review, autoSend: false, statuses: ["review"] };
  api.mockImplementation(async (method) => ({ threadId: "review-thread", draft: method === "tasks.runButton" ? "Review this." : undefined }) as never);
  const view = wrap(footer(async () => true, { status: "in_progress" }, [unsent]));
  expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
  view.unmount();

  localStorage.setItem("openorc.draft.conversation.review-thread", JSON.stringify({ text: "Look at the tests too." }));
  wrap(footer(async () => true, { status: "review" }, [unsent]));
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  await waitFor(() => expect(openThread).toHaveBeenCalledWith("review-thread"));
  expect(JSON.parse(localStorage.getItem("openorc.draft.conversation.review-thread")!)).toEqual({ text: "Look at the tests too.\n\nReview this." });
  localStorage.clear();
});

it("leaves the thread's saved draft to bring an unsent message when nothing is typed here", async () => {
  api.mockImplementation(async (method) => ({ threadId: "review-thread", draft: method === "tasks.runButton" ? "Review this." : undefined }) as never);
  localStorage.clear();
  wrap(footer(async () => true, {}, [{ ...review, autoSend: false }]));
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  await waitFor(() => expect(openThread).toHaveBeenCalledWith("review-thread"));
  expect(localStorage.length).toBe(0);
});

it("keeps a skill saved earlier while the prompt calls it, though the agent no longer lists it", async () => {
  const old = { ...review, prompt: "/old-review the changes", skills: ["old-review"] } satisfies TaskButton;
  wrap(<TaskButtonsSection project={{ ...project, settings: { ...project.settings, taskButtons: [old] } }} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Review button" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Edit button" }));
  await waitFor(() => expect(calls("skills.list")).toContainEqual({ scope: { kind: "project", id: "project" }, agent: "claude" }));
  fireEvent.click(dialog.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(calls("projects.updateSettings")).toHaveLength(1));
  expect(savedButtons()).toEqual([old]);
});

it("lists Pi's skills by their names alone, as the prompt calls them", async () => {
  const { result } = renderHook(() => usePromptSkills("project", { agent: "pi", model: "pi-test", effort: null }), {
    wrapper: ({ children }) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>,
  });
  await waitFor(() => expect(result.current.skills.map((skill) => skill.name)).toEqual(["say-hello", "review-mine"]));
  expect(calls("skills.list")).toContainEqual({ scope: { kind: "project", id: "project" }, agent: "pi" });
});
