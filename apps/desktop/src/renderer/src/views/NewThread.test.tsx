import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TEAM_LIMITS, WORKSPACE_ID, harnessIds, type Project, type RpcResults, type TeamDetail } from "@openorc/protocol";
import { readNewThreadDraft, writeNewThreadDraft } from "../lib/new-thread-draft";
import { useRouter } from "../lib/router";

const start = vi.fn();
const resetStart = vi.fn();
let projects: Project[];
let teams: TeamDetail[];
let models: RpcResults["agents.models"];
let system: RpcResults["system.info"];
let branches: Record<string, string | null | undefined>;
let branchError: boolean;

vi.mock("../lib/query", () => ({
  useRpc: (method: string, params: { id?: string }) => {
    const data: Record<string, unknown> = {
      "projects.list": projects,
      "projects.git": "ready",
      "projects.checkoutBranch": branches[params.id ?? ""],
      "workspace.get": undefined,
      "system.info": system,
      "agents.models": models,
      "app.settings.get": { defaultWorkspaceMode: "current" },
      "orchestration.list": teams,
      "orchestration.availability": { enabled: true, reason: null, maxHierarchyDepth: 3 },
    };
    return { data: data[method], isError: method === "projects.checkoutBranch" && branchError, isPending: false, isLoading: false, error: null, refetch: vi.fn() };
  },
  useRpcMutation: (method: string) =>
    method === "threads.start" ? { mutateAsync: start, reset: resetStart, isPending: false, error: null } : { mutateAsync: vi.fn(), mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null },
}));
vi.mock("../lib/permission-default", () => ({ usePermissionSelection: () => ({ permission: "review", ready: true, select: vi.fn(), error: null }) }));
vi.mock("../lib/skill-commands", () => ({ useSkillCommands: () => [] }));
vi.mock("../lib/composer-changes", () => ({ useComposerChanges: () => null }));
vi.mock("../components/NewThreadActivity", () => ({ useArrivalActivity: () => ({ any: false }), ArrivalPanel: () => null }));
vi.mock("../components/NewThreadMascot", () => ({ NewThreadMascot: () => null }));
vi.mock("../components/Panel", () => ({ Panel: () => null }));
vi.mock("../components/TopBar", () => ({ TopBar: ({ children }: { children: React.ReactNode }) => <header>{children}</header> }));
vi.mock("../components/ModelPicker", () => ({
  defaultChoice: () => null,
  ModelPicker: () => <button type="button">Choose model</button>,
  ComposerModelPicker: () => <button type="button">Choose model</button>,
}));

import { NewThread } from "./NewThread";

const makeProject = (id: string): Project => ({
  id,
  name: id,
  rootPath: `/${id}`,
  defaultBranch: "main",
  gitRemote: null,
  settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc/", detectedConfigs: [] },
  createdAt: 1,
  updatedAt: 1,
});

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  projects = [makeProject("p1"), makeProject("p2")];
  branches = { p1: "prod", p2: "release" };
  branchError = false;
  teams = [];
  models = [{ id: "codex-model", label: "Codex", agent: "codex", isDefault: true, efforts: ["medium"], defaultEffort: "medium" }];
  system = {
    dataDir: "/data",
    harnesses: harnessIds.map((id) => ({ id, state: id === "codex" ? "ready" : "sign_in", path: `/bin/${id}`, version: "1", revision: 1 })),
    gh: { installed: false, path: null },
  };
  start.mockReset();
  start.mockResolvedValue({ thread: { id: "thread-1" } });
  resetStart.mockReset();
  useRouter.setState({ route: { view: "newthread", projectId: "p1" }, threadIds: [], history: [], future: [] });
});

function saveModelDraft(projectId: string, prompt: string) {
  const draft = { ...readNewThreadDraft(projectId), prompt, target: { kind: "model" as const, choice: { agent: "codex" as const, model: "codex-model", effort: "medium", fastMode: false } } };
  writeNewThreadDraft(draft);
  return draft;
}

describe("NewThread", () => {
  it("shows the checked-out prod branch when the project default is dev", () => {
    projects[0]!.defaultBranch = "dev";
    const { container } = render(<NewThread projectId="p1" />);
    expect(container.querySelector(".composer-branch")?.textContent).toBe("prod");
  });

  it("updates the branch after a checkout refresh", () => {
    const view = render(<NewThread projectId="p1" />);
    expect(view.container.querySelector(".composer-branch")?.textContent).toBe("prod");
    branches.p1 = "hotfix";
    view.rerender(<NewThread projectId="p1" />);
    expect(view.container.querySelector(".composer-branch")?.textContent).toBe("hotfix");
  });

  it.each([null, undefined])("does not substitute the default branch when the checkout branch is %s", (branch) => {
    branches.p1 = branch;
    const { container } = render(<NewThread projectId="p1" />);
    expect(container.querySelector(".composer-branch")).toBeNull();
  });

  it("hides a stale checkout branch if refreshing it fails", () => {
    branchError = true;
    const { container } = render(<NewThread projectId="p1" />);
    expect(container.querySelector(".composer-branch")).toBeNull();
  });

  it("keeps the default branch as the starting point for a new worktree", () => {
    projects[0]!.defaultBranch = "dev";
    writeNewThreadDraft({ ...readNewThreadDraft("p1"), workspace: "worktree" });
    const { container } = render(<NewThread projectId="p1" />);
    expect(container.querySelector(".composer-branch")?.textContent).toBe("dev");
  });

  it("shows the selected folder without a branch in Workspace", () => {
    projects = [makeProject(WORKSPACE_ID)];
    writeNewThreadDraft({ ...readNewThreadDraft(WORKSPACE_ID), workingDirectory: "/chosen/folder" });
    const { container } = render(<NewThread projectId={WORKSPACE_ID} />);
    expect(container.querySelector(".composer-branch")).toBeNull();
    expect(screen.getByText("/chosen/folder")).toBeTruthy();
  });

  it("starts a recovered draft from the keyboard and opens the accepted thread", async () => {
    saveModelDraft("p1", "Recovered request");
    render(<NewThread projectId="p1" />);
    const message = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
    expect(message.value).toBe("Recovered request");
    fireEvent.keyDown(message, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", agent: "codex", model: "codex-model", prompt: "Recovered request" })));
    await waitFor(() => expect(useRouter.getState().route).toEqual({ view: "thread", threadId: "thread-1" }));
    expect(readNewThreadDraft("p1").prompt).toBe("");
  });

  it("remounts the composer with each project’s own recovered prompt and target", () => {
    saveModelDraft("p1", "First project");
    saveModelDraft("p2", "Second project");
    const view = render(<NewThread projectId="p1" />);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" }).value).toBe("First project");
    expect(view.container.querySelector(".composer-branch")?.textContent).toBe("prod");
    view.rerender(<NewThread projectId="p2" />);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" }).value).toBe("Second project");
    expect(view.container.querySelector(".composer-branch")?.textContent).toBe("release");
    expect(readNewThreadDraft("p1").prompt).toBe("First project");
  });

  it("keeps the recovered prompt when its saved solo model is unavailable", () => {
    saveModelDraft("p1", "Retain this request");
    models = [];
    render(<NewThread projectId="p1" />);
    const message = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
    expect(message.value).toBe("Retain this request");
    expect(screen.getByRole("status").textContent).toContain("selected model is unavailable");
    fireEvent.keyDown(message, { key: "Enter", code: "Enter" });
    expect(start).not.toHaveBeenCalled();
  });

  it("keeps a recovered team request while preventing start for an archived team", () => {
    const revision: TeamDetail["revision"] = {
      id: "revision-1",
      teamId: "team-1",
      projectId: "p1",
      number: 1,
      name: "Team",
      createdAt: 1,
      limits: { ...DEFAULT_TEAM_LIMITS },
      members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Lead", settings: { agent: "codex", model: "codex-model", effort: "medium", fastMode: false } }],
    };
    teams = [{ revision, team: { id: "team-1", projectId: "p1", currentRevisionId: revision.id, archivedAt: 2, createdAt: 1, updatedAt: 2 } }];
    writeNewThreadDraft({ ...readNewThreadDraft("p1"), prompt: "Retained direction", target: { kind: "team", revision, initialLeadOverrides: {} } });
    render(<NewThread projectId="p1" />);
    const message = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
    expect(message.value).toBe("Retained direction");
    expect(screen.getByRole("status").textContent).toContain("archived");
    fireEvent.keyDown(message, { key: "Enter", code: "Enter" });
    expect(start).not.toHaveBeenCalled();
    expect(readNewThreadDraft("p1").prompt).toBe("Retained direction");
  });
});

it("prepares a starter as an editable plan without starting a run", () => {
  saveModelDraft("p1", "");
  render(<NewThread projectId="p1" />);
  fireEvent.click(screen.getByRole("button", { name: "Explore this project" }));
  const message = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
  expect(message.value).toContain("Walk me through this project");
  expect(document.activeElement).toBe(message);
  expect(screen.queryByRole("group", { name: "Suggested prompts" })).toBeNull();
  expect(readNewThreadDraft("p1").mode).toBe("plan");
  expect(start).not.toHaveBeenCalled();
  fireEvent.change(message, { target: { value: "Explore just the renderer" } });
  expect(readNewThreadDraft("p1").prompt).toBe("Explore just the renderer");
});

it("offers starters only for an empty draft", () => {
  saveModelDraft("p1", "Keep my current request");
  render(<NewThread projectId="p1" />);
  expect(screen.queryByRole("group", { name: "Suggested prompts" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "" } });
  expect(screen.getByRole("button", { name: "Explore this project" })).toBeTruthy();
  expect(start).not.toHaveBeenCalled();
});
