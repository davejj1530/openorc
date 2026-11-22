import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelOption, TaskRefine } from "@openorc/protocol";
import type { useTaskDocumentDraft } from "../../lib/task-document-draft";
import { accounts, api, calls, enabledAccount, wrap } from "../test-fixtures/task-choices";
import { useTaskRefine } from "./TaskRefine";

vi.mock("./RefineSuggestion", () => ({ RefineSuggestion: ({ suggestion }: { suggestion: string }) => <div data-testid="suggestion">{suggestion}</div> }));
vi.mock("../DocumentEditor", () => ({
  DocumentEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Suggested description" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

type TaskDocument = ReturnType<typeof useTaskDocumentDraft>;
const models: ModelOption[] = [
  { id: "test-model", label: "Test", agent: "codex", efforts: ["high", "low"], defaultEffort: "high", isDefault: true },
  { id: "opus-test", label: "Opus Test", agent: "claude", efforts: ["high"], defaultEffort: "high", isDefault: false },
];
const recipient = { agent: "codex" as const, model: "test-model", effort: "high" };
const suggestion = { title: "Edit task labels as chips", description: "## Goal\n\nOne at a time.", labels: ["tasks", "ui"], note: "Based on TaskDocumentFields.tsx." };
let refine: TaskRefine | null;
let modelList = models;
let availability: { id: string; state: string }[] | null = null;
let defaultHarness: string | null = null;
let dismissFails = false;
let separate = false;
const replace = vi.fn();
const patch = vi.fn();
const flush = vi.fn(async () => true);
const draft = { title: "labels input is clunky", spec: "cant remove one", labels: "" };
const document = (overrides: Partial<typeof draft> = {}) =>
  ({ draft: { ...draft, ...overrides }, patch, flush, body: { current: { replace, focus: () => {}, flush: async () => true } } }) as unknown as TaskDocument;
const ready = (over: Partial<TaskRefine> = {}): TaskRefine => ({
  id: "refine",
  taskId: "task",
  state: "ready",
  recipient,
  instruction: "Add how to verify it",
  base: { title: draft.title, spec: draft.spec, labels: [] },
  suggestion,
  step: null,
  error: null,
  runId: "run",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  refine = null;
  modelList = models;
  replace.mockReset();
  patch.mockReset();
  flush.mockClear();
  availability = null;
  defaultHarness = null;
  dismissFails = false;
  separate = false;
  api.mockReset().mockImplementation(async (method) => {
    if (method === "agents.models") return modelList as never;
    if (method === "agents.availability") return availability as never;
    if (method === "app.settings.get") return { defaultHarness, claudeAccountsSeparate: separate } as never;
    if (method === "tasks.get") return { id: "task", threadId: null, executionThreadId: "work-thread" } as never;
    if (method === "threads.get") return { id: "work-thread", agent: "claude", claudeAccountId: "work" } as never;
    if (method === "orclings.list") return [] as never;
    if (method === "claude.accounts.list") return accounts as never;
    if (method === "tasks.refine.get") return refine as never;
    if (method === "tasks.refine.start") return ready({ state: "running", suggestion: null }) as never;
    if (method === "tasks.refine.dismiss" && dismissFails) throw new Error("The suggestion couldn’t be put away.");
    return null as never;
  });
});
afterEach(cleanup);

function Harness({ value }: { value: TaskDocument }) {
  const view = useTaskRefine("task", value);
  return (
    <div>
      {view.title}
      {view.bar}
      {view.button}
      {view.suggestion}
      {view.labels}
    </div>
  );
}
const mount = (value = document()) => wrap(<Harness value={value} />);

it("saves the draft, then refines with what the person typed and the model they chose", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Refine" }));
  const sheet = await screen.findByRole("dialog");
  const instruction = within(sheet).getByRole<HTMLTextAreaElement>("textbox", { name: "What should change?" });
  expect(instruction.maxLength).toBe(4000);
  fireEvent.change(instruction, { target: { value: "Add how to verify it" } });
  await waitFor(() => expect(within(sheet).getByRole<HTMLSelectElement>("combobox", { name: "Refine with" }).value).toContain("test-model"));
  fireEvent.click(within(sheet).getByRole("button", { name: "Refine" }));
  await waitFor(() => expect(calls("tasks.refine.start")).toEqual([{ taskId: "task", recipient, instruction: "Add how to verify it", again: false }]));
  const started = api.mock.calls.findIndex(([name]) => name === "tasks.refine.start");
  expect(flush.mock.invocationCallOrder[0]).toBeLessThan(api.mock.invocationCallOrder[started]!);
});

it("refines a Claude model on the account chosen, and offers that account next time", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Refine" }));
  let sheet = await screen.findByRole("dialog");
  const refineWith = within(sheet).getByRole<HTMLSelectElement>("combobox", { name: "Refine with" });
  await waitFor(() => expect(refineWith.value).toContain("test-model"));
  expect(within(sheet).getByRole<HTMLSelectElement>("combobox", { name: "Account" }).disabled).toBe(true);
  fireEvent.change(refineWith, { target: { value: JSON.stringify(["claude", "opus-test", "high"]) } });
  const choose = await enabledAccount(within(sheet));
  expect(
    within(choose)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["Default", "Work", "Personal"]);
  fireEvent.change(choose, { target: { value: "personal" } });
  fireEvent.click(within(sheet).getByRole("button", { name: "Refine" }));
  const claude = { agent: "claude", model: "opus-test", effort: "high" };
  await waitFor(() => expect(calls("tasks.refine.start")).toEqual([{ taskId: "task", recipient: claude, claudeAccountId: "personal", instruction: "", again: false }]));

  cleanup();
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Refine" }));
  sheet = await screen.findByRole("dialog");
  await waitFor(() => expect(within(sheet).getByRole<HTMLSelectElement>("combobox", { name: "Refine with" }).value).toContain("opus-test"));
  expect((await enabledAccount(within(sheet))).value).toBe("personal");
});

it("refines a Claude model only on the task's account while accounts are kept separate", async () => {
  separate = true;
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Refine" }));
  const sheet = await screen.findByRole("dialog");
  const refineWith = within(sheet).getByRole<HTMLSelectElement>("combobox", { name: "Refine with" });
  await waitFor(() => expect(refineWith.value).toContain("test-model"));
  fireEvent.change(refineWith, { target: { value: JSON.stringify(["claude", "opus-test", "high"]) } });
  const field = () => within(sheet).getByRole<HTMLSelectElement>("combobox", { name: "Account" });
  await waitFor(() => expect(field().textContent).toBe("Work (kept separate)"));
  expect(field().disabled).toBe(true);
  fireEvent.click(within(sheet).getByRole("button", { name: "Refine" }));
  const claude = { agent: "claude", model: "opus-test", effort: "high" };
  await waitFor(() => expect(calls("tasks.refine.start")).toEqual([{ taskId: "task", recipient: claude, claudeAccountId: "work", instruction: "", again: false }]));
});

it("shows the agent at work and stops it", async () => {
  refine = ready({ state: "running", suggestion: null, step: "Reading TaskDocumentFields.tsx" });
  mount();
  expect(await screen.findByText("Test is refining…")).toBeTruthy();
  expect(screen.getByText("Reading TaskDocumentFields.tsx")).toBeTruthy();
  expect(screen.getByText(/You asked “Add how to verify it”/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Refine" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(calls("tasks.refine.stop")).toEqual([{ taskId: "task" }]));
});

it("shows the suggestion in place of the document, and using it edits the draft and puts it away", async () => {
  refine = ready();
  mount();
  expect(await screen.findByText("Suggested by Test")).toBeTruthy();
  expect(screen.getByText(/Based on TaskDocumentFields\.tsx\./)).toBeTruthy();
  expect(screen.getByText("labels input is clunky").tagName).toBe("DEL");
  expect(screen.getByTestId("suggestion").textContent).toBe(suggestion.description);
  expect(screen.queryByText(/Suggested from an earlier version/)).toBeNull();
  expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Use suggestion" }));
  expect(replace).toHaveBeenCalledWith(suggestion.description);
  expect(patch).toHaveBeenCalledWith({ title: suggestion.title, spec: suggestion.description, labels: "tasks, ui" });
  await waitFor(() => expect(calls("tasks.refine.dismiss")).toEqual([{ taskId: "task" }]));
  expect(screen.queryByText("Suggested by Test")).toBeNull();
});

it("says when the document moved on since the agent started, and when it found nothing to change", async () => {
  refine = ready();
  const view = mount(document({ spec: "cant remove one, edited meanwhile" }));
  expect(await screen.findByText(/Suggested from an earlier version\. Changes to the task since aren’t in it\./)).toBeTruthy();
  view.unmount();
  refine = ready({ state: "unchanged", suggestion: { ...suggestion, note: "It already says what it needs to." } });
  mount();
  expect(await screen.findByText("Test found nothing to change.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(calls("tasks.refine.dismiss")).toEqual([{ taskId: "task" }]));
});

it("lets the person edit the suggestion first, keeps the edits across a remount, and uses the edited version", async () => {
  refine = ready();
  const first = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  expect(screen.getByText("Editing Test’s suggestion")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Suggested title" }), { target: { value: "Edit labels as chips" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Suggested description" }), { target: { value: "## Goal\n\nOne at a time, with Backspace." } });
  fireEvent.change(screen.getByRole("textbox", { name: "Suggested labels" }), { target: { value: "tasks" } });
  first.unmount();

  mount();
  expect(await screen.findByText("Suggested by Test, with your edits")).toBeTruthy();
  expect(screen.getByTestId("suggestion").textContent).toBe("## Goal\n\nOne at a time, with Backspace.");
  fireEvent.click(screen.getByRole("button", { name: "Use suggestion" }));
  expect(replace).toHaveBeenCalledWith("## Goal\n\nOne at a time, with Backspace.");
  expect(patch).toHaveBeenCalledWith({ title: "Edit labels as chips", spec: "## Goal\n\nOne at a time, with Backspace.", labels: "tasks" });
  await waitFor(() => expect(calls("tasks.refine.dismiss")).toEqual([{ taskId: "task" }]));
  expect(localStorage.getItem("openorc.draft.task-refine.task")).toBeNull();
});

it("refines again from the person's edited version, and keeps those edits until the new run has a suggestion of its own", async () => {
  refine = ready();
  localStorage.setItem("openorc.draft.task-refine.task", JSON.stringify({ refineId: "refine", title: "Edit labels as chips", spec: "## Goal\n\nMine.", labels: "tasks" }));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Refine again" }));
  const sheet = await screen.findByRole("dialog");
  expect(within(sheet).getByText("Starts from your edited version.")).toBeTruthy();
  fireEvent.change(within(sheet).getByRole("textbox", { name: "What should change?" }), { target: { value: "Shorter" } });
  await waitFor(() => expect(within(sheet).getByRole<HTMLSelectElement>("combobox", { name: "Refine with" }).value).toContain("test-model"));
  fireEvent.click(within(sheet).getByRole("button", { name: "Refine" }));
  await waitFor(() =>
    expect(calls("tasks.refine.start")).toEqual([
      { taskId: "task", recipient, instruction: "Shorter", again: true, edited: { title: "Edit labels as chips", description: "## Goal\n\nMine.", labels: ["tasks"] } },
    ]),
  );
  expect(localStorage.getItem("openorc.draft.task-refine.task")).toContain("Mine.");
});

it("shows the earlier suggestion with the person's edits and why when Refine again didn't finish", async () => {
  refine = ready({ error: "Usage limit reached." });
  localStorage.setItem("openorc.draft.task-refine.task", JSON.stringify({ refineId: "refine", title: "Edit labels as chips", spec: "## Goal\n\nMine.", labels: "tasks" }));
  mount();
  expect(await screen.findByText("Suggested by Test, with your edits")).toBeTruthy();
  expect(screen.getByTestId("suggestion").textContent).toBe("## Goal\n\nMine.");
  expect(screen.getByText(/Refining again didn’t finish: Usage limit reached\./)).toBeTruthy();
});

it("leaves out edits made to a suggestion a newer one replaced", async () => {
  refine = ready({ id: "newer" });
  localStorage.setItem("openorc.draft.task-refine.task", JSON.stringify({ refineId: "refine", title: "Edit labels as chips", spec: "## Goal\n\nMine.", labels: "tasks" }));
  mount();
  expect(await screen.findByText("Suggested by Test")).toBeTruthy();
  expect(screen.getByTestId("suggestion").textContent).toBe(suggestion.description);
});

it("offers only the agents signed in here, starting on the person's default agent", async () => {
  availability = [
    { id: "codex", state: "sign_in" },
    { id: "claude", state: "ready" },
  ];
  defaultHarness = "claude";
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Refine" }));
  const sheet = await screen.findByRole("dialog");
  const refineWith = within(sheet).getByRole<HTMLSelectElement>("combobox", { name: "Refine with" });
  await waitFor(() => expect(refineWith.value).toContain("opus-test"));
  expect(
    within(refineWith)
      .getAllByRole("option")
      .some((option) => option.getAttribute("value")?.includes("codex")),
  ).toBe(false);
});

it("starts on the person's default agent at its model's default effort when more than one is signed in, else on the first agent OpenOrc lists", async () => {
  modelList = [models[0]!, { ...models[1]!, efforts: ["low", "high"], defaultEffort: "high" }];
  availability = [
    { id: "codex", state: "ready" },
    { id: "claude", state: "ready" },
  ];
  const startsOn = async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Refine" }));
    return within(await screen.findByRole("dialog")).getByRole<HTMLSelectElement>("combobox", { name: "Refine with" });
  };
  defaultHarness = "claude";
  const refineWith = await startsOn();
  await waitFor(() => expect(refineWith.value).toBe(JSON.stringify(["claude", "opus-test", "high"])));
  expect(within(refineWith).getAllByRole("option")).toHaveLength(4);
  cleanup();

  defaultHarness = null;
  const onDefault = await startsOn();
  await waitFor(() => expect(onDefault.value).toBe(JSON.stringify(["codex", "test-model", "high"])));
});

it("says when the agent couldn't finish, and tries again from the sheet", async () => {
  refine = ready({ state: "error", suggestion: null, error: "The agent stopped before suggesting anything." });
  mount();
  expect(await screen.findByText("Test couldn’t finish refining.")).toBeTruthy();
  expect(screen.getByText("The agent stopped before suggesting anything.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  const sheet = await screen.findByRole("dialog", { name: "Refine this task" });
  await waitFor(() => expect(within(sheet).getByRole<HTMLSelectElement>("combobox", { name: "Refine with" }).value).toContain("test-model"));
  fireEvent.click(within(sheet).getByRole("button", { name: "Refine" }));
  await waitFor(() => expect(calls("tasks.refine.start")).toEqual([{ taskId: "task", recipient, instruction: "", again: false }]));
});

it("starts one Refine however often it is asked for while the task saves", async () => {
  let save!: (saved: boolean) => void;
  flush.mockImplementationOnce(() => new Promise<boolean>((resolve) => (save = resolve)));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Refine" }));
  const sheet = await screen.findByRole("dialog");
  await waitFor(() => expect(within(sheet).getByRole<HTMLSelectElement>("combobox", { name: "Refine with" }).value).toContain("test-model"));
  fireEvent.click(within(sheet).getByRole("button", { name: "Refine" }));
  const pending = within(sheet).getByRole<HTMLButtonElement>("button", { name: "Starting…" });
  expect(pending.disabled).toBe(true);
  fireEvent.click(pending);
  fireEvent.keyDown(within(sheet).getByRole("textbox", { name: "What should change?" }), { key: "Enter", metaKey: true });
  save(true);
  await waitFor(() => expect(calls("tasks.refine.start")).toHaveLength(1));
  expect(flush).toHaveBeenCalledOnce();
});

it("refines nothing and says why when the task's latest changes couldn't be saved", async () => {
  flush.mockImplementationOnce(async () => false);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Refine" }));
  const sheet = await screen.findByRole("dialog");
  await waitFor(() => expect(within(sheet).getByRole<HTMLSelectElement>("combobox", { name: "Refine with" }).value).toContain("test-model"));
  fireEvent.click(within(sheet).getByRole("button", { name: "Refine" }));
  expect((await within(sheet).findByRole("alert")).textContent).toBe("The task’s latest changes couldn’t be saved, so it can’t be refined yet.");
  expect(calls("tasks.refine.start")).toEqual([]);
});

it("shows the suggestion again with the person's edits and why when it couldn't be dismissed, until another Refine starts", async () => {
  refine = ready();
  dismissFails = true;
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Suggested title" }), { target: { value: "Edit labels as chips" } });
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(await screen.findByText(/The suggestion couldn’t be put away\./)).toBeTruthy();
  expect(screen.getByText("Editing Test’s suggestion")).toBeTruthy();
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Suggested title" }).value).toBe("Edit labels as chips");

  fireEvent.click(screen.getByRole("button", { name: "Refine again" }));
  const sheet = await screen.findByRole("dialog");
  await waitFor(() => expect(within(sheet).getByRole<HTMLSelectElement>("combobox", { name: "Refine with" }).value).toContain("test-model"));
  fireEvent.click(within(sheet).getByRole("button", { name: "Refine" }));
  await waitFor(() => expect(calls("tasks.refine.start")).toHaveLength(1));
  await waitFor(() => expect(screen.queryByText(/couldn’t be put away/)).toBeNull());
});

it("offers Refine again once a Refine was cancelled", async () => {
  refine = ready({ state: "cancelled", suggestion: null });
  mount();
  expect(await screen.findByRole("button", { name: "Refine" })).toHaveProperty("disabled", false);
  expect(screen.queryByText(/Suggested by/)).toBeNull();
});

it("can't use a suggestion whose title is empty", async () => {
  refine = ready({ suggestion: { ...suggestion, title: " " } });
  mount();
  expect(await screen.findByRole("button", { name: "Use suggestion" })).toHaveProperty("disabled", true);
});

it("can't refine with no agent signed in here", async () => {
  availability = [
    { id: "codex", state: "sign_in" },
    { id: "claude", state: "sign_in" },
  ];
  mount();
  await waitFor(() => expect(screen.getByRole("button", { name: "Refine" })).toHaveProperty("disabled", true));
});
