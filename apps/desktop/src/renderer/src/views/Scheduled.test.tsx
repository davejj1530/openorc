import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_TEAM_LIMITS, Schedule, TeamRevision } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Scheduled } from "./Scheduled";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/query";
import { useLayout } from "../lib/layout";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onInvalidate: vi.fn(), onReady: vi.fn() } }));
vi.mock("../components/TopBar", () => ({
  TopBar: ({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) => (
    <div>
      {children}
      {actions}
    </div>
  ),
}));
vi.mock("../components/ModelPicker", () => {
  const Picker = ({ teams }: { teams?: { selectedLabel?: string; options: { revisionId: string; name: string }[]; onSelect: (id: string) => void } }) => (
    <div>
      {teams?.selectedLabel ? <span>Selected: {teams.selectedLabel}</span> : null}
      {teams?.options.map((option) => (
        <button type="button" key={option.revisionId} onClick={() => teams.onSelect(option.revisionId)}>
          Choose {option.name}
        </button>
      ))}
    </div>
  );
  return { ModelPicker: Picker, ComposerModelPicker: Picker, defaultChoice: () => null };
});

const revision = TeamRevision.parse({
  id: "revision",
  teamId: "team",
  projectId: "project",
  number: 1,
  createdAt: 1,
  name: "Reviewers",
  limits: DEFAULT_TEAM_LIMITS,
  members: [{ key: "lead", name: "Lead", responsibility: "Review", managerKey: null, settings: { agent: "codex", model: "model", effort: null, fastMode: false } }],
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
  useLayout.setState({ projectId: null });
  vi.mocked(core.call).mockImplementation(async (method, input) => {
    if (method === "projects.list")
      return [
        { id: "project", name: "Project" },
        { id: "other", name: "Other project" },
      ] as never;
    if (method === "schedules.list") return [...(schedule ? [schedule] : []), ...paused] as never;
    if (method === "orchestration.list") return ((input as { projectId: string }).projectId === "project" ? [{ team: { id: "team", projectId: "project", archivedAt: null }, revision }] : []) as never;
    if (method === "orchestration.availability") return { enabled: true, reason: null, maxHierarchyDepth: 3 } as never;
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
  queryClient.clear();
  vi.resetAllMocks();
});

it("keeps active and paused schedules on separate tabs and filters them by name", async () => {
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
  fireEvent.change(screen.getByRole("textbox", { name: "Filter schedules" }), { target: { value: "weekly" } });
  await screen.findByText("No matching schedules");
  fireEvent.change(screen.getByRole("textbox", { name: "Filter schedules" }), { target: { value: "" } });
  paused = [];
  await queryClient.invalidateQueries({ queryKey: ["schedules.list", {}] });
  await screen.findByText("No paused schedules");
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

it("preserves a failed save and keeps a selected team through a project mismatch", async () => {
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
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
  fireEvent.click(await screen.findByRole("button", { name: "Choose Reviewers" }));
  expect(screen.getByText("Selected: Reviewers")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Schedule project" }), { target: { value: "other" } });
  await screen.findByText(/The selected team belongs to another project/);
  expect(screen.getByText("Selected: Reviewers")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
});
