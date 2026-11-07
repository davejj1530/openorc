import { NO_CLOUD_SERVICE, WORKSPACE_ID, harnessIds, type CloudSignIns, type Project, type RpcResults } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readNewThreadDraft, writeNewThreadDraft } from "../lib/new-thread-draft";
import { useLayout } from "../lib/layout";
import { useRouter } from "../lib/router";

const start = vi.fn();
const resetStart = vi.fn();
let projects: Project[];
let models: RpcResults["agents.models"];
let system: RpcResults["system.info"];
let branches: Record<string, string | null | undefined>;
let branchError: boolean;
let accounts: RpcResults["claude.accounts.list"] | undefined;
let settings: Partial<RpcResults["app.settings.get"]>;
let offer: RpcResults["cloud.offer"] | undefined;
let signIns: CloudSignIns;
const mutated: [string, unknown][] = [];
/** A project's reads held open by a test; any other project's are already in. */
const arrivalReads: Record<string, Promise<unknown>> = {};

vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpc: (method: string, params: { id?: string }) => {
    const data: Record<string, unknown> = {
      "projects.list": projects,
      "claude.accounts.list": accounts,
      "projects.git": "ready",
      "projects.checkoutBranch": branches[params.id ?? ""],
      "workspace.get": undefined,
      "system.info": system,
      "agents.models": models,
      "app.settings.get": settings,
      "cloud.offer": offer,
      "cloud.signIns": signIns,
      "orchestration.availability": { enabled: true, reason: null, maxHierarchyDepth: 3 },
    };
    return { data: data[method], isError: method === "projects.checkoutBranch" && branchError, isPending: false, isLoading: false, error: null, refetch: vi.fn() };
  },
  useRpcMutation: (method: string) =>
    method === "threads.start"
      ? { mutateAsync: start, reset: resetStart, isPending: false, error: null }
      : { mutateAsync: vi.fn(), mutate: (params: unknown) => mutated.push([method, params]), reset: vi.fn(), isPending: false, error: null },
  usePermissionSelection: () => ({ permission: "review", ready: true, select: vi.fn(), error: null }),
}));
vi.mock("../lib/rpc", () => ({ core: { call: async (method: string) => (method === "cloud.signIns" ? signIns : null), onReady: () => () => {}, onPush: () => () => {} } }));
vi.mock("../lib/skill-commands", () => ({ useSkillCommands: () => [] }));
vi.mock("../lib/composer-changes", () => ({ useComposerChanges: () => null }));
vi.mock("../components/NewThreadActivity", () => ({
  useArrivalActivity: () => ({ any: false }),
  NewThreadRecent: () => null,
  loadArrivalActivity: (id: string) => arrivalReads[id] ?? Promise.resolve(),
}));
vi.mock("../components/NewThreadMascot", () => ({ NewThreadMascot: () => null }));
vi.mock("../components/Panel", () => ({ Panel: () => null }));
vi.mock("../components/ProjectIconPicker", () => ({ ProjectIconPicker: () => null, ProjectIcon: () => null }));
vi.mock("../components/TopBar", () => ({ TopBar: ({ children }: { children: React.ReactNode }) => <header>{children}</header> }));
vi.mock("../components/ModelPicker", () => ({
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
  accounts = {
    defaultId: "work",
    accounts: ["personal", "work", "client"].map((id, createdAt) => ({ id, name: id, kind: "managed", enabled: true, createdAt, status: "ready", email: null, organization: null, message: null })),
  };
  settings = { defaultWorkspaceMode: "current", defaultHarness: null };
  offer = undefined;
  signIns = { rows: [], bringing: false };
  mutated.length = 0;
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

  it("switches projects from the question, restores that draft, and sends to the chosen project", async () => {
    saveModelDraft("p1", "First project");
    saveModelDraft("p2", "Second project");
    render(<NewThread projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Project: p1" }));
    expect(screen.getByRole("heading").textContent).toBe("What should we work on in p1?");
    fireEvent.click(await screen.findByRole("button", { name: "p2" }));
    await screen.findByRole("button", { name: "Project: p2" });
    const message = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
    expect(message.value).toBe("Second project");
    expect(useLayout.getState().projectId).toBe("p2");
    fireEvent.keyDown(message, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p2", prompt: "Second project" })));
    expect(readNewThreadDraft("p1").prompt).toBe("First project");
  });

  it("finds a project by typing and switches on Enter without the key reaching the prompt", async () => {
    projects = Array.from({ length: 9 }, (_, index) => makeProject(`p${index + 1}`));
    render(<NewThread projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Project: p1" }));
    const field = await screen.findByRole("textbox", { name: "Find a project" });
    fireEvent.change(field, { target: { value: "p7" } });
    expect(screen.queryByRole("button", { name: "p2" })).toBeNull();
    expect(fireEvent.keyDown(field, { key: "Enter" })).toBe(false);
    expect(await screen.findByRole("button", { name: "Project: p7" })).toBeTruthy();
  });

  it("lands on the last project chosen when an earlier switch is still reading", async () => {
    projects = ["p1", "p2", "p3"].map(makeProject);
    let finishP2Reads = () => {};
    arrivalReads.p2 = new Promise<void>((resolve) => (finishP2Reads = resolve));
    render(<NewThread projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Project: p1" }));
    fireEvent.click(await screen.findByRole("button", { name: "p2" }));
    fireEvent.click(screen.getByRole("button", { name: "Project: p1" }));
    fireEvent.click(await screen.findByRole("button", { name: "p3" }));
    await screen.findByRole("button", { name: "Project: p3" });
    await act(async () => finishP2Reads());
    expect(screen.getByRole("button", { name: "Project: p3" })).toBeTruthy();
    expect(useLayout.getState().projectId).toBe("p3");
    delete arrivalReads.p2;
  });

  it("chooses a worktree above the prompt and uses it for the first turn", async () => {
    saveModelDraft("p1", "Build in a separate checkout");
    render(<NewThread projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Where the thread works: Local checkout" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Worktree / }));
    expect(readNewThreadDraft("p1").workspace).toBe("worktree");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", workspaceMode: "worktree", prompt: "Build in a separate checkout" })));
  });

  it("starts a cloud thread on the cloud brain for a project it has a copy of", async () => {
    offer = { offered: true, provider: "vercel", brain: { host: "brain-key", projects: [{ mac: "p1", cloud: "brain-p1" }] } };
    writeNewThreadDraft({ ...saveModelDraft("p1", "Run this in the cloud"), workspace: "cloud" });
    render(<NewThread projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Where the thread works: Cloud" }));
    expect((await screen.findByRole("menuitem", { name: /^Cloud On your cloud brain/ })).getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", workspaceMode: "worktree", cloud: true })));
  });

  it("offers Cloud disabled with why, and starts in a worktree, for a project the cloud brain has no copy of", async () => {
    offer = { offered: true, provider: "vercel", brain: { host: "brain-key", projects: [{ mac: "p2", cloud: "brain-p2" }] } };
    writeNewThreadDraft({ ...saveModelDraft("p1", "Run this in the cloud"), workspace: "cloud" });
    render(<NewThread projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Where the thread works: Worktree" }));
    const cloud = await screen.findByRole("menuitem", { name: "Cloud Not on your cloud brain yet" });
    expect(cloud.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.not.objectContaining({ cloud: true })));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ workspaceMode: "worktree" }));
  });

  it("offers to add a project the cloud brain has no copy of, in Cloud settings with its sheet open", async () => {
    offer = { offered: true, provider: "vercel", brain: { host: "brain-key", projects: [{ mac: "p2", cloud: "brain-p2" }] } };
    render(<NewThread projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: /^Where the thread works/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Add this project" }));
    expect(useRouter.getState().route).toEqual({ view: "settings", section: "cloud", project: "p1" });
  });

  it("points to Cloud settings when no cloud service is connected", async () => {
    offer = { offered: true, provider: null, brain: null };
    render(<NewThread projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: /^Where the thread works/ }));
    expect(await screen.findByRole("menuitem", { name: `Cloud ${NO_CLOUD_SERVICE}` })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open Cloud settings" }));
    expect(useRouter.getState().route).toEqual({ view: "settings", section: "cloud" });
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

it("keeps a chosen third Claude account in the draft and sends it when starting", async () => {
  models = [{ id: "claude-fixture", label: "Claude", agent: "claude", isDefault: true, efforts: [], defaultEffort: null }];
  system.harnesses = system.harnesses.map((row) => ({ ...row, state: "ready" }));
  writeNewThreadDraft({ ...readNewThreadDraft("p1"), prompt: "Use the client account", target: { kind: "model", choice: { agent: "claude", model: "claude-fixture", effort: null } } });
  const view = render(<NewThread projectId="p1" />);
  const picker = screen.getByRole<HTMLSelectElement>("combobox", { name: "Claude account" });
  expect(picker.value).toBe("work");
  expect(picker.options).toHaveLength(3);
  fireEvent.change(picker, { target: { value: "client" } });
  expect(readNewThreadDraft("p1").claudeAccountId).toBe("client");
  accounts!.defaultId = "personal";
  view.rerender(<NewThread projectId="p1" />);
  expect(picker.value).toBe("client");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ agent: "claude", claudeAccountId: "client", prompt: "Use the client account" })));
});

it.each([
  { name: "the core's default harness", defaultHarness: "claude", onboarding: null, agent: "claude" },
  { name: "the first signed-in harness without one", defaultHarness: null, onboarding: null, agent: "codex" },
  // Before App hands a profile's earlier onboarding choice to the core, the choice still decides.
  { name: "an onboarding choice the core does not hold yet", defaultHarness: null, onboarding: "claude", agent: "claude" },
  { name: "the core's default over an older onboarding choice", defaultHarness: "codex", onboarding: "claude", agent: "codex" },
] as const)("offers $name, as a phone would", async ({ defaultHarness, onboarding, agent }) => {
  models = [...models, { id: "claude-fixture", label: "Claude", agent: "claude", isDefault: true, efforts: [], defaultEffort: null }];
  system.harnesses = system.harnesses.map((row) => ({ ...row, state: "ready" }));
  settings = { ...settings, defaultHarness };
  if (onboarding) localStorage.setItem("openorc.onboarding", JSON.stringify({ version: 1, step: "done", completedAt: 1, selectedHarnesses: ["codex", "claude"], defaultHarness: onboarding }));
  render(<NewThread projectId="p1" />);
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Fix the build" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ agent, prompt: "Fix the build" })));
});

it("offers the one sign-in a cloud start lacks where it was sent, and starts once it is ready", async () => {
  models = [{ id: "claude-fixture", label: "Claude", agent: "claude", isDefault: true, efforts: [], defaultEffort: null }];
  system.harnesses = system.harnesses.map((row) => ({ ...row, state: "ready" }));
  offer = { offered: true, provider: "vercel", brain: null };
  const work = { kind: "claude", accountId: "work", label: "Work", way: "private-window", error: null } as const;
  signIns = { rows: [{ ...work, state: "missing" }], bringing: false };
  writeNewThreadDraft({
    ...readNewThreadDraft("p1"),
    prompt: "Run this in the cloud",
    workspace: "cloud",
    target: { kind: "model", choice: { agent: "claude", model: "claude-fixture", effort: null } },
  });
  const view = render(<NewThread projectId="p1" />);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("Claude account “Work” has no sign-in for the cloud.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(mutated).toEqual([["cloud.signIns.bring", { target: { kind: "claude", accountId: "work" } }]]);
  expect(start).not.toHaveBeenCalled();
  signIns = { rows: [{ ...work, state: "ready" }], bringing: false };
  act(() => view.rerender(<NewThread projectId="p1" />));
  await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ cloud: true, claudeAccountId: "work", prompt: "Run this in the cloud" })));
  expect(screen.queryByText("Claude account “Work” has no sign-in for the cloud.")).toBeNull();
});

it("keeps the message when the person calls a waiting cloud start off", async () => {
  models = [{ id: "claude-fixture", label: "Claude", agent: "claude", isDefault: true, efforts: [], defaultEffort: null }];
  system.harnesses = system.harnesses.map((row) => ({ ...row, state: "ready" }));
  offer = { offered: true, provider: "vercel", brain: null };
  signIns = { rows: [{ kind: "claude", accountId: "work", label: "Work", way: "private-window", error: null, state: "missing" }], bringing: false };
  writeNewThreadDraft({
    ...readNewThreadDraft("p1"),
    prompt: "Run this in the cloud",
    workspace: "cloud",
    target: { kind: "model", choice: { agent: "claude", model: "claude-fixture", effort: null } },
  });
  render(<NewThread projectId="p1" />);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByText("Claude account “Work” has no sign-in for the cloud.")).toBeNull());
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" }).value).toBe("Run this in the cloud");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(start).not.toHaveBeenCalled();
});
