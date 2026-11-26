import { Schedule } from "@openorc/protocol";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../lib/client";
import { useLayout } from "../lib/layout";
import { core } from "../lib/rpc";
import { useRouter } from "../lib/router";
import { spaceNavigation } from "../lib/space-navigation";
import { Scheduled } from "./Scheduled";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
vi.mock("../components/TopBar", () => ({
  TopBar: ({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) => (
    <div>
      {children}
      {actions}
    </div>
  ),
}));
vi.mock("../components/ModelPicker", () => {
  const Picker = ({ value, onChange }: { value: { model: string | null } | null; onChange: (choice: { agent: "codex"; model: string; effort: null; fastMode: false }) => void }) => (
    <button type="button" onClick={() => onChange({ agent: "codex", model: "model", effort: null, fastMode: false })}>
      {value ? "Model selected" : "Choose model"}
    </button>
  );
  return { ModelPicker: Picker, ComposerModelPicker: Picker, defaultChoice: () => null };
});
function savedSchedule() {
  return Schedule.parse({
    id: "schedule",
    projectId: "project",
    title: "Review",
    prompt: "Inspect the repository",
    agent: "codex",
    model: "model",
    effort: null,
    mode: "plan",
    permissionMode: "trusted",
    workspaceMode: "current",
    everyMinutes: 60,
    version: 1,
    enabled: true,
    lastRunAt: null,
    nextRunAt: 2,
    lastThreadId: null,
    createdAt: 1,
    updatedAt: 1,
    executionTarget: { kind: "model", settings: { agent: "codex", model: "model", effort: null, fastMode: false } },
  });
}

let schedule: Schedule | null;
let paused: Schedule[];
let saveFailure: boolean;
beforeEach(() => {
  schedule = null;
  paused = [];
  saveFailure = false;
  useLayout.setState({ workspace: "all" });
  vi.mocked(core.call).mockImplementation(async (method, _input) => {
    if (method === "projects.list")
      return [
        { id: "project", name: "Project", rootPath: "/tmp/project" },
        { id: "other", name: "Other project", rootPath: "/tmp/other" },
      ] as never;
    if (method === "spaces.projects") return spaceNavigation.getState().inventory.find((space) => space.id === ("spaceId" in _input ? _input.spaceId : undefined))?.projects as never;
    if (method === "schedules.list") return [...(schedule ? [schedule] : []), ...paused] as never;
    if (method === "board.jobs") return [];
    if (method === "agents.models") return [];
    if (method === "system.info") return { harnesses: [{ id: "codex", state: "ready", path: "/bin/codex", version: "1", revision: 1 }] } as never;
    if (method === "app.settings.get") return { defaultPermissionMode: "trusted" } as never;
    if (method === "schedules.update") {
      if (saveFailure) throw new Error("Save unavailable");
      return schedule as never;
    }
    if (method === "schedules.create") return schedule as never;
    throw new Error(`Unexpected RPC: ${method}`);
  });
});
afterEach(() => {
  cleanup();
  if (spaceNavigation.getState().key) spaceNavigation.getState().end();
  queryClient.clear();
  vi.resetAllMocks();
});

it("preserves the existing unscoped list and scopes schedules to the selected space's local projects", async () => {
  schedule = savedSchedule();
  paused = [{ ...savedSchedule(), id: "other-schedule", projectId: "other", title: "Other review" }];
  render(
    <QueryClientProvider client={queryClient}>
      <Scheduled />
    </QueryClientProvider>,
  );
  await screen.findByText("Other review");
  const project = (id: string) => ({ key: id, name: id, repo: null, localProjectId: id, hostedProjectId: null, connected: false });
  act(() => {
    spaceNavigation.getState().initialize("schedules", "personal", [
      { id: "personal", personal: true, projects: [project("other")], threads: [], taskIds: [] },
      { id: "birch", personal: false, projects: [project("project")], threads: [], taskIds: [] },
    ]);
    spaceNavigation.getState().select("birch");
  });
  await screen.findByRole("button", { name: /Review/ });
  await waitFor(() => expect(screen.queryByText("Other review")).toBeNull());
});

it("keeps active and paused schedules on separate tabs", async () => {
  schedule = savedSchedule();
  paused = [{ ...savedSchedule(), id: "paused", title: "Nightly docs", enabled: false }];
  render(
    <QueryClientProvider client={queryClient}>
      <Scheduled />
    </QueryClientProvider>,
  );
  await screen.findByRole("button", { name: /Review/ });
  expect(screen.queryByText("Nightly docs")).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Paused" }));
  await screen.findByText("Nightly docs");
  expect(screen.queryByRole("button", { name: /Review/ })).toBeNull();
  expect(screen.getAllByText("Paused")).toHaveLength(2);
  paused = [];
  await queryClient.invalidateQueries({ queryKey: ["schedules.list", {}] });
  await screen.findByText("No paused automations");
});

it("says the last run as a dot and a word, and opens the thread a failed run left", async () => {
  const failed = {
    id: "f",
    state: "failed",
    trigger: "timer",
    scheduledFor: null,
    threadId: "run-thread",
    executionId: null,
    reason: "The agent stopped.",
    createdAt: Date.now() - 3_600_000,
    finishedAt: null,
  } as const;
  schedule = { ...savedSchedule(), lastFire: failed };
  paused = [{ ...savedSchedule(), id: "quiet", title: "Nightly docs", enabled: true, lastRunAt: Date.now() - 7_200_000 }];
  render(
    <QueryClientProvider client={queryClient}>
      <Scheduled />
    </QueryClientProvider>,
  );
  await screen.findByText("Failed 1h ago");
  expect(screen.getByText("Ran 2h ago")).toBeTruthy();
  expect(screen.queryByText("The agent stopped.")).toBeNull();
  expect(screen.getAllByRole("button", { name: "Open run" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Open run" }));
  expect(useRouter.getState().route).toMatchObject({ view: "thread", threadId: "run-thread" });
});

it("keeps the reason of a failed run that left no thread under its row", async () => {
  schedule = {
    ...savedSchedule(),
    lastFire: {
      id: "f",
      state: "failed",
      trigger: "timer",
      scheduledFor: null,
      threadId: null,
      executionId: null,
      reason: "The project folder is gone.",
      createdAt: Date.now() - 60_000,
      finishedAt: null,
    },
  };
  render(
    <QueryClientProvider client={queryClient}>
      <Scheduled />
    </QueryClientProvider>,
  );
  await screen.findByText("The project folder is gone.");
  expect(screen.queryByRole("button", { name: "Open run" })).toBeNull();
});

it("retains an edited schedule when a newer version arrives and reloads only on request", async () => {
  schedule = savedSchedule();
  render(
    <QueryClientProvider client={queryClient}>
      <Scheduled />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Review/ }));
  const name = screen.getByPlaceholderText("Nightly dependency check") as HTMLInputElement;
  fireEvent.change(name, { target: { value: "Local edit" } });
  schedule = { ...schedule, title: "Remote edit", version: 2 };
  await queryClient.invalidateQueries({ queryKey: ["schedules.list", {}] });
  await screen.findByText(/This schedule changed elsewhere/);
  expect(name.value).toBe("Local edit");
  fireEvent.click(screen.getByRole("button", { name: "Load saved schedule" }));
  await waitFor(() => expect((screen.getByPlaceholderText("Nightly dependency check") as HTMLInputElement).value).toBe("Remote edit"));
});

it("preserves a failed save for retry", async () => {
  schedule = savedSchedule();
  saveFailure = true;
  render(
    <QueryClientProvider client={queryClient}>
      <Scheduled />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Review/ }));
  const name = screen.getByPlaceholderText("Nightly dependency check") as HTMLInputElement;
  fireEvent.change(name, { target: { value: "Unsent review" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(/Save unavailable Your draft is kept in this editor/);
  expect(name.value).toBe("Unsent review");
});

it("offers a schedule only the Claude accounts its project uses, moving one saved before onto the project's default", async () => {
  schedule = Schedule.parse({
    ...savedSchedule(),
    agent: "claude",
    claudeAccountId: "work",
    executionTarget: { kind: "model", settings: { agent: "claude", model: "model", effort: null, fastMode: false } },
  });
  const account = (id: string) => ({ id, name: id, kind: "managed", enabled: true, createdAt: 1, status: "ready", email: null, organization: null, message: null });
  const base = vi.mocked(core.call).getMockImplementation()!;
  vi.mocked(core.call).mockImplementation((async (method: string, input: never) => {
    if (method === "projects.list")
      return [{ id: "project", name: "Project", settings: { claudeAccounts: { only: true, accountIds: ["personal", "client"], defaultId: "personal", autoSwitch: false } } }];
    if (method === "claude.accounts.list") return { defaultId: "work", accounts: ["work", "personal", "client"].map(account) };
    return base(method as never, input);
  }) as never);
  render(
    <QueryClientProvider client={queryClient}>
      <Scheduled />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Review/ }));
  const picker = await screen.findByRole<HTMLSelectElement>("combobox", { name: "Claude account" });
  await waitFor(() => expect([...picker.options].map((option) => option.value)).toEqual(["personal", "client"]));
  expect(picker.value).toBe("personal");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("schedules.update", expect.objectContaining({ patch: expect.objectContaining({ claudeAccountId: "personal" }) })));
});
