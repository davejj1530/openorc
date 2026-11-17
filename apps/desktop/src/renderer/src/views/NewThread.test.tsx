import { WORKSPACE_ID, harnessIds, type AccountStatus, type Project, type RpcResults } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readNewThreadDraft, readNewThreadProject, rememberNewThreadProject, writeNewThreadDraft } from "../lib/new-thread-draft";
import { useLayout } from "../lib/layout";
import { useRouter } from "../lib/router";
import { spaceNavigation } from "../lib/space-navigation";

const start = vi.fn();
const resetStart = vi.fn();
let projects: Project[];
/** The project list's first answer has not arrived. */
let listLoading = false;
let models: RpcResults["agents.models"];
let cloudModels: RpcResults["cloudModels.catalog"];
let system: RpcResults["system.info"];
let branches: Record<string, string | null | undefined>;
let branchError: boolean;
let accounts: RpcResults["claude.accounts.list"] | undefined;
let settings: Partial<RpcResults["app.settings.get"]>;
let account: AccountStatus | undefined;
const mutated: [string, unknown][] = [];
/** A project's git read held open by a test; any other project's is already in. */
const gitReads: Record<string, Promise<unknown>> = {};
/** Every read the screen asked for, with its parameters; a read it holds back with `enabled: false` is not asked. */
const reads: [string, unknown][] = [];
let gitState = "ready";

vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpcs: () => [],
  useRpc: (method: string, params: { id?: string; spaceId?: string }, options?: { enabled?: boolean }) => {
    if (options?.enabled !== false) reads.push([method, params]);
    const data: Record<string, unknown> = {
      "projects.list": listLoading ? undefined : projects,
      "spaces.projects": spaceNavigation.getState().inventory.find((space) => space.id === params.spaceId)?.projects,
      "claude.accounts.list": accounts,
      "projects.git": gitState,
      "projects.checkoutBranch": branches[params.id ?? ""],
      "workspace.get": undefined,
      "system.info": system,
      "agents.models": models,
      "cloudModels.catalog": cloudModels,
      "app.settings.get": settings,
      "account.status": account,
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
vi.mock("../lib/rpc", () => ({ core: { call: async () => null, onReady: () => () => {}, onPush: () => () => {} } }));
vi.mock("../lib/skill-commands", async (original) => ({
  projectScope: (await original<typeof import("../lib/skill-commands")>()).projectScope,
  useSkillCommands: (scope: unknown) => (reads.push(["skills.list", { scope }]), { commands: [], onCommandsWanted: () => {} }),
}));
vi.mock("../lib/composer-changes", () => ({ useComposerChanges: () => null }));
vi.mock("../lib/project-git", async (original) => ({
  ...(await original<object>()),
  loadProjectGit: (id: string) => gitReads[id] ?? Promise.resolve(),
}));
vi.mock("../components/NewThreadMascot", () => ({ NewThreadMascot: () => null }));
vi.mock("../components/Panel", () => ({ Panel: () => null }));
vi.mock("../components/ProjectIconPicker", () => ({ ProjectIconPicker: () => null, ProjectIcon: () => null }));
vi.mock("../components/TopBar", () => ({ TopBar: ({ children }: { children: React.ReactNode }) => <header>{children}</header> }));
// The picker's own rows are its tests'; here, the Claude accounts the screen hands it, and what choosing one does.
vi.mock("../components/ModelPicker", () => ({
  ModelPicker: () => <button type="button">Choose model</button>,
  ComposerModelPicker: ({ accounts, limits }: { accounts?: PickerAccounts; limits?: { harnesses: readonly string[]; fast: boolean } }) => (
    <>
      <button type="button">Choose model</button>
      <span data-testid="agents-offered">{limits ? `${limits.harnesses.join(", ")}${limits.fast ? "" : ", no fast mode"}` : "this Mac's"}</span>
      {accounts ? (
        <div role="group" aria-label="Claude account">
          {accounts.accounts.map((account) => (
            <button key={account.id} type="button" aria-pressed={account.id === accounts.current} onClick={() => accounts.choose(account.id)}>
              {account.name}
            </button>
          ))}
        </div>
      ) : null}
    </>
  ),
}));
const accountGroup = () => within(screen.getByRole("group", { name: "Claude account" }));
const chosenAccount = () => accountGroup().getByRole("button", { pressed: true }).textContent;
const offeredAccounts = () =>
  accountGroup()
    .getAllByRole("button")
    .map((button) => button.textContent);

import type { PickerAccounts } from "../components/ModelPickerAccounts";
import { NewThread } from "./NewThread";
import { messageOf, type } from "../components/composer-editor/testing";

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

afterEach(() => {
  cleanup();
  listLoading = false;
  if (spaceNavigation.getState().key) spaceNavigation.getState().end();
});
beforeEach(() => {
  gitState = "ready";
  localStorage.clear();
  projects = [makeProject("p1"), makeProject("p2")];
  branches = { p1: "prod", p2: "release" };
  branchError = false;
  accounts = {
    defaultId: "work",
    accounts: ["personal", "work", "client"].map((id, createdAt) => ({ id, name: id, kind: "managed", enabled: true, createdAt, status: "ready", email: null, organization: null, message: null })),
  };
  settings = { defaultWorkspaceMode: "current", defaultHarness: null };
  account = undefined;
  mutated.length = 0;
  models = [{ id: "codex-model", label: "Codex", agent: "codex", isDefault: true, efforts: ["medium"], defaultEffort: "medium" }];
  cloudModels = null;
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

/** A Pro account with Codex signed in on OpenOrc Cloud, and project p1's repository where it stands there. */
function openOrcCloud(cloud: "added" | "addable"): AccountStatus {
  return {
    state: "signed-in",
    email: "ada@example.com",
    name: "Ada",
    image: null,
    reach: "live",
    plan: { pro: true, standing: "live", at: 0 },
    hours: { leftSeconds: 3600, monthly: null, packsLeftSeconds: 3600 },
    sandbox: null,
    signIns: [{ agent: "codex", provider: "openai", label: "ChatGPT Plus", ended: false }],
    signingIn: {},
    github: { configured: true, login: "ada", installedOn: ["acme"], repositories: ["acme/p1"] },
    connectingGithub: null,
    paying: null,
    projects: [{ projectId: "p1", repo: "acme/p1", cloud }],
    error: null,
  };
}

function saveModelDraft(projectId: string, prompt: string) {
  const draft = { ...readNewThreadDraft(projectId), prompt, target: { kind: "model" as const, choice: { agent: "codex" as const, model: "codex-model", effort: "medium", fastMode: false } } };
  writeNewThreadDraft(draft);
  return draft;
}

/** What the place control in the composer's bar says under the pointer: where the thread will work, and on which branch. */
const placeSays = () => screen.getByRole("button", { name: /^Where the thread works/ }).getAttribute("data-tip");

describe("NewThread", () => {
  it("asks this Mac for none of a cloud-only project's skills, which it does not hold", () => {
    projects = [{ ...makeProject("p1"), rootPath: "" }];
    spaceNavigation.getState().initialize("scoped", "personal", [
      { id: "personal", personal: true, projects: [], threads: [], taskIds: [] },
      {
        id: "birch",
        personal: false,
        projects: [{ key: "p1", name: "Canvas", repo: "example/canvas", localProjectId: null, hostedProjectId: "cloud-project", connected: true }],
        threads: [],
        taskIds: [],
      },
    ]);
    spaceNavigation.getState().select("birch");
    reads.length = 0;
    render(<NewThread projectId="p1" />);
    const scoped = reads.filter(([method, params]) => method === "skills.list" && JSON.stringify(params).includes('"kind":"project","id":"p1"'));
    expect(scoped).toEqual([]);
  });

  it.each([
    ["while the project list is still loading", true],
    ["once the list says the project has no folder here", false],
  ])("asks this Mac nothing about a cloud-only project's checkout or skills %s", (_when, loading) => {
    projects = [{ ...makeProject("p1"), rootPath: "" }];
    listLoading = loading;
    spaceNavigation.getState().initialize("scoped", "personal", [
      { id: "personal", personal: true, projects: [], threads: [], taskIds: [] },
      {
        id: "birch",
        personal: false,
        projects: [{ key: "p1", name: "Canvas", repo: "example/canvas", localProjectId: null, hostedProjectId: "cloud-project", connected: true }],
        threads: [],
        taskIds: [],
      },
    ]);
    spaceNavigation.getState().select("birch");
    reads.length = 0;
    render(<NewThread projectId="p1" />);
    expect(reads.filter(([method]) => method === "projects.git" || method === "projects.checkoutBranch")).toEqual([]);
    expect(reads.filter(([method, params]) => method === "skills.list" && JSON.stringify(params).includes('"id":"p1"'))).toEqual([]);
  });

  it("asks for no project's activity while there is no project to start in", () => {
    projects = [];
    reads.length = 0;
    render(<NewThread projectId="" />);
    expect(reads.filter(([method, params]) => method === "projects.activity" && !(params as { id: string }).id)).toEqual([]);
  });

  it("shows the checked-out prod branch when the project default is dev", () => {
    projects[0]!.defaultBranch = "dev";
    render(<NewThread projectId="p1" />);
    expect(placeSays()).toBe("Works in the local checkout on prod");
  });

  it("updates the branch after a checkout refresh", () => {
    const view = render(<NewThread projectId="p1" />);
    expect(placeSays()).toBe("Works in the local checkout on prod");
    branches.p1 = "hotfix";
    view.rerender(<NewThread projectId="p1" />);
    expect(placeSays()).toBe("Works in the local checkout on hotfix");
  });

  it.each([null, undefined])("does not substitute the default branch when the checkout branch is %s", (branch) => {
    branches.p1 = branch;
    render(<NewThread projectId="p1" />);
    expect(placeSays()).toBe("Works in the local checkout");
  });

  it("hides a stale checkout branch if refreshing it fails", () => {
    branchError = true;
    render(<NewThread projectId="p1" />);
    expect(placeSays()).toBe("Works in the local checkout");
  });

  it("keeps the default branch as the starting point for a new worktree", () => {
    projects[0]!.defaultBranch = "dev";
    writeNewThreadDraft({ ...readNewThreadDraft("p1"), workspace: "worktree" });
    render(<NewThread projectId="p1" />);
    expect(placeSays()).toBe("Works in a new worktree off dev");
  });

  it("shows the selected folder without a branch in Workspace", () => {
    projects = [makeProject(WORKSPACE_ID)];
    writeNewThreadDraft({ ...readNewThreadDraft(WORKSPACE_ID), workingDirectory: "/chosen/folder" });
    render(<NewThread projectId={WORKSPACE_ID} />);
    expect(screen.getByRole("button", { name: "Choose the folder for this conversation" }).getAttribute("data-tip")).toBe("Works in /chosen/folder");
  });

  it("starts a recovered draft from the keyboard and opens the accepted thread", async () => {
    saveModelDraft("p1", "Recovered request");
    render(<NewThread projectId="p1" />);
    const message = screen.getByRole("textbox", { name: "Message" });
    expect(messageOf(message)).toBe("Recovered request");
    fireEvent.keyDown(message, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", agent: "codex", model: "codex-model", prompt: "Recovered request" })));
    await waitFor(() => expect(useRouter.getState().route).toEqual({ view: "thread", threadId: "thread-1" }));
    expect(readNewThreadDraft("p1").prompt).toBe("");
  });

  it("remounts the composer with each project’s own recovered prompt and target", () => {
    saveModelDraft("p1", "First project");
    saveModelDraft("p2", "Second project");
    const view = render(<NewThread projectId="p1" />);
    expect(messageOf(screen.getByRole("textbox", { name: "Message" }))).toBe("First project");
    expect(placeSays()).toBe("Works in the local checkout on prod");
    view.rerender(<NewThread projectId="p2" />);
    expect(messageOf(screen.getByRole("textbox", { name: "Message" }))).toBe("Second project");
    expect(placeSays()).toBe("Works in the local checkout on release");
    expect(readNewThreadDraft("p1").prompt).toBe("First project");
  });

  it("switches projects from the question, restores that draft, and sends to the chosen project", async () => {
    saveModelDraft("p1", "First project");
    saveModelDraft("p2", "Second project");
    useLayout.setState({ workspace: "p1" });
    render(<NewThread projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Project: p1" }));
    expect(screen.getByRole("heading").textContent).toBe("What should we work on in p1?");
    fireEvent.click(await screen.findByRole("button", { name: "p2" }));
    await screen.findByRole("button", { name: "Project: p2" });
    const message = screen.getByRole("textbox", { name: "Message" });
    expect(messageOf(message)).toBe("Second project");
    expect(useLayout.getState().workspace).toBe("p2");
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
    gitReads.p2 = new Promise<void>((resolve) => (finishP2Reads = resolve));
    useLayout.setState({ workspace: "p1" });
    render(<NewThread projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Project: p1" }));
    fireEvent.click(await screen.findByRole("button", { name: "p2" }));
    fireEvent.click(screen.getByRole("button", { name: "Project: p1" }));
    fireEvent.click(await screen.findByRole("button", { name: "p3" }));
    await screen.findByRole("button", { name: "Project: p3" });
    await act(async () => finishP2Reads());
    expect(screen.getByRole("button", { name: "Project: p3" })).toBeTruthy();
    expect(useLayout.getState().workspace).toBe("p3");
    delete gitReads.p2;
  });

  it("starts in the project the sidebar's filter focuses, and follows the filter while open", async () => {
    useLayout.setState({ workspace: "p2" });
    render(<NewThread />);
    await screen.findByRole("button", { name: "Project: p2" });
    act(() => useLayout.getState().setWorkspace("p1"));
    await screen.findByRole("button", { name: "Project: p1" });
  });

  it("gives a remembered project that was removed way to Workspace on All projects", async () => {
    useLayout.setState({ workspace: "all" });
    rememberNewThreadProject("removed");
    render(<NewThread />);
    await waitFor(() => expect(readNewThreadProject()).toBe(WORKSPACE_ID));
  });

  it("chooses a worktree above the prompt and uses it for the first turn", async () => {
    saveModelDraft("p1", "Build in a separate checkout");
    render(<NewThread projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Where the thread works: Local checkout" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Worktree/ }));
    expect(readNewThreadDraft("p1").workspace).toBe("worktree");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", workspaceMode: "worktree", prompt: "Build in a separate checkout" })));
  });

  it("keeps the checkout and OpenOrc Cloud for a folder with no commit yet, dimming only Worktree with why", async () => {
    gitState = "no_commits";
    account = openOrcCloud("added");
    saveModelDraft("p1", "Add a health check");
    render(<NewThread projectId="p1" />);
    const place = screen.getByRole("button", { name: /^Where the thread works/ });
    expect(place.hasAttribute("disabled")).toBe(false);
    fireEvent.click(place);
    const worktree = await screen.findByRole("menuitem", { name: /^Worktree/ });
    expect([worktree.getAttribute("aria-disabled"), worktree.getAttribute("aria-description")]).toEqual(["true", "Worktrees need a first commit."]);
    expect(screen.getByRole("menuitem", { name: "Local checkout" }).getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "OpenOrc Cloud 1 h" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", hosted: true, prompt: "Add a health check" })));
  });

  it("starts a thread on OpenOrc Cloud from a project with a folder on this Mac without this Mac's own agent sign-in", async () => {
    account = openOrcCloud("added");
    system = { ...system, harnesses: system.harnesses.map((row) => ({ ...row, state: "sign_in" as const })) };
    saveModelDraft("p1", "Add a health check");
    render(<NewThread projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: /^Where the thread works/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "OpenOrc Cloud 1 h" }));
    const send = screen.getByRole("button", { name: "Send" });
    expect(send.getAttribute("data-tip")).not.toMatch(/Sign in to/);
    fireEvent.click(send);
    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", hosted: true, prompt: "Add a health check" })));
  });

  it("offers a cloud start from a project with a folder on this Mac what a cloud thread's composer does, not this Mac's Claude accounts", async () => {
    const cloud = openOrcCloud("added");
    if (cloud.state !== "signed-in") throw new Error("Expected a signed-in account");
    account = { ...cloud, signIns: [...(cloud.signIns ?? []), { agent: "claude", provider: "anthropic", label: "Claude Max", ended: false }] };
    models = [...models, { id: "claude-model", label: "Claude", agent: "claude", isDefault: true, efforts: [], defaultEffort: null }];
    system = { ...system, harnesses: system.harnesses.map((row) => (row.id === "claude" ? { ...row, state: "ready" as const } : row)) };
    writeNewThreadDraft({ ...readNewThreadDraft("p1"), prompt: "Add a health check", target: { kind: "model", choice: { agent: "claude", model: "claude-model", effort: null, fastMode: false } } });
    render(<NewThread projectId="p1" />);
    expect(offeredAccounts()).toEqual(["personal", "work", "client"]);
    expect(screen.getByTestId("agents-offered").textContent).toBe("this Mac's");
    fireEvent.click(screen.getByRole("button", { name: /^Where the thread works/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "OpenOrc Cloud 1 h" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Claude account" })).toBeNull());
    expect(screen.getByTestId("agents-offered").textContent).toBe("claude, codex, opencode, no fast mode");
  });

  it("starts a thread on OpenOrc Cloud for a project there, with no folder on this Mac", async () => {
    account = openOrcCloud("added");
    saveModelDraft("p1", "Add a health check");
    render(<NewThread projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: /^Where the thread works/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "OpenOrc Cloud 1 h" }));
    expect(placeSays()).toMatch(/^Works on OpenOrc Cloud, on a new branch from/);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", hosted: true, prompt: "Add a health check" })));
    expect(start).toHaveBeenCalledWith(expect.not.objectContaining({ workspaceMode: expect.anything() }));
  });

  it("starts a cloud-only project's thread on a model OpenOrc Cloud runs, though this Mac has none", async () => {
    account = openOrcCloud("added");
    models = [];
    cloudModels = { models: [{ id: "", label: "Codex default", agent: "codex", isDefault: true, efforts: [], defaultEffort: null }], providers: [] };
    projects = [{ ...makeProject("p1"), rootPath: "" }];
    spaceNavigation
      .getState()
      .initialize("scoped", "personal", [
        {
          id: "personal",
          personal: true,
          projects: [{ key: "p1", name: "Canvas", repo: "example/canvas", localProjectId: null, hostedProjectId: "cloud-project", connected: true }],
          threads: [],
          taskIds: [],
        },
      ]);
    writeNewThreadDraft({ ...readNewThreadDraft("p1"), prompt: "Add a health check" });
    render(<NewThread projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", hosted: true, agent: "codex", model: "" })));
  });

  it.each([false, true])("offers only OpenOrc Cloud for a scoped cloud-only project without requiring a local sign-in (account loading: %s)", async (loading) => {
    account = loading ? undefined : openOrcCloud("added");
    projects = [{ ...makeProject("p1"), rootPath: "" }];
    system = { ...system, harnesses: system.harnesses.map((row) => ({ ...row, state: "sign_in" as const })) };
    spaceNavigation.getState().initialize("scoped", "personal", [
      { id: "personal", personal: true, projects: [], threads: [], taskIds: [] },
      {
        id: "birch",
        personal: false,
        projects: [{ key: "p1", name: "Canvas", repo: "example/canvas", localProjectId: null, hostedProjectId: "cloud-project", connected: true }],
        threads: [],
        taskIds: [],
      },
    ]);
    spaceNavigation.getState().select("birch");
    saveModelDraft("p1", "Add a health check");
    const view = render(<NewThread projectId="p1" />);
    if (loading) {
      expect(screen.getByRole("button", { name: "Send" }).getAttribute("disabled")).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /^Where the thread works/ }));
      expect((await screen.findByRole("menuitem", { name: "OpenOrc Cloud Checking" })).getAttribute("aria-disabled")).toBe("true");
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      account = openOrcCloud("added");
      view.rerender(<NewThread projectId="p1" />);
    }
    fireEvent.click(screen.getByRole("button", { name: /^Where the thread works/ }));
    expect(await screen.findByRole("menuitem", { name: "OpenOrc Cloud 1 h" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Local checkout" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Worktree" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ spaceId: "birch", projectId: "p1", hosted: true })));
  });

  it("offers only this Mac for an open local folder detached from the organization", async () => {
    account = openOrcCloud("added");
    const project = { key: "p1", name: "Canvas", repo: "example/canvas", localProjectId: "p1", hostedProjectId: "server-project", connected: true };
    spaceNavigation.getState().initialize("scoped", "personal", [
      { id: "personal", personal: true, projects: [], threads: [], taskIds: [] },
      { id: "birch", personal: false, projects: [project], threads: [{ id: "local", projectId: "p1" }], taskIds: [] },
    ]);
    spaceNavigation.getState().select("birch");
    useRouter.getState().navigate({ view: "thread", threadId: "local" });
    spaceNavigation.getState().reconcile([
      { id: "personal", personal: true, projects: [project], threads: [{ id: "local", projectId: "p1" }], taskIds: [] },
      { id: "birch", personal: false, projects: [], threads: [], taskIds: [] },
    ]);
    saveModelDraft("p1", "Keep this on my Mac");
    render(<NewThread projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: /^Where the thread works/ }));
    expect(await screen.findByRole("menuitem", { name: "Local checkout" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Worktree" })).toBeTruthy();
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", workspaceMode: "current" })));
    expect(start).not.toHaveBeenCalledWith(expect.objectContaining({ spaceId: expect.anything() }));
    expect(start).not.toHaveBeenCalledWith(expect.objectContaining({ hosted: true }));
  });

  it("ends OpenOrc Cloud's row in adding a project not there yet, leading to its row in Cloud settings", async () => {
    account = openOrcCloud("addable");
    render(<NewThread projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: /^Where the thread works/ }));
    const choice = await screen.findByRole("menuitem", { name: "OpenOrc Cloud Add this project" });
    expect(choice.getAttribute("aria-description")).toBe("acme/p1 is not on OpenOrc Cloud yet.");
    fireEvent.click(choice);
    expect(useRouter.getState().route).toEqual({ view: "settings", section: "cloud", project: "p1" });
  });

  it("never offers OpenOrc Cloud to someone with no account", async () => {
    account = { state: "signed-out", signingIn: null, ended: false, error: null };
    render(<NewThread projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: /^Where the thread works/ }));
    await screen.findByRole("menuitem", { name: /^Worktree/ });
    expect(screen.queryByRole("menuitem", { name: /^OpenOrc Cloud/ })).toBeNull();
  });

  it("keeps the recovered prompt when its saved solo model is unavailable", () => {
    saveModelDraft("p1", "Retain this request");
    models = [];
    render(<NewThread projectId="p1" />);
    const message = screen.getByRole("textbox", { name: "Message" });
    expect(messageOf(message)).toBe("Retain this request");
    expect(screen.getByRole("status").textContent).toContain("selected model is unavailable");
    fireEvent.keyDown(message, { key: "Enter", code: "Enter" });
    expect(start).not.toHaveBeenCalled();
  });
});

it("keeps a chosen third Claude account in the draft and sends it when starting", async () => {
  models = [{ id: "claude-fixture", label: "Claude", agent: "claude", isDefault: true, efforts: [], defaultEffort: null }];
  system.harnesses = system.harnesses.map((row) => ({ ...row, state: "ready" }));
  writeNewThreadDraft({ ...readNewThreadDraft("p1"), prompt: "Use the client account", target: { kind: "model", choice: { agent: "claude", model: "claude-fixture", effort: null } } });
  const view = render(<NewThread projectId="p1" />);
  expect(chosenAccount()).toBe("work");
  expect(offeredAccounts()).toHaveLength(3);
  fireEvent.click(accountGroup().getByRole("button", { name: "client" }));
  expect(readNewThreadDraft("p1").claudeAccountId).toBe("client");
  accounts!.defaultId = "personal";
  view.rerender(<NewThread projectId="p1" />);
  expect(chosenAccount()).toBe("client");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ agent: "claude", claudeAccountId: "client", prompt: "Use the client account" })));
});

it("offers only the Claude accounts its project uses, starting on the project's default when the draft's is not one of them", async () => {
  models = [{ id: "claude-fixture", label: "Claude", agent: "claude", isDefault: true, efforts: [], defaultEffort: null }];
  system.harnesses = system.harnesses.map((row) => ({ ...row, state: "ready" }));
  projects[0]!.settings.claudeAccounts = { only: true, accountIds: ["personal", "client"], defaultId: "client", autoSwitch: false };
  // Chosen before the project narrowed its accounts.
  writeNewThreadDraft({
    ...readNewThreadDraft("p1"),
    claudeAccountId: "work",
    prompt: "Use the project's account",
    target: { kind: "model", choice: { agent: "claude", model: "claude-fixture", effort: null } },
  });
  render(<NewThread projectId="p1" />);
  expect(chosenAccount()).toBe("client");
  expect(offeredAccounts()).toEqual(["personal", "client"]);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ claudeAccountId: "client", prompt: "Use the project's account" })));
  cleanup();
  start.mockClear();

  // A draft's account the project uses stays chosen.
  writeNewThreadDraft({ ...readNewThreadDraft("p1"), claudeAccountId: "personal", prompt: "Use personal" });
  render(<NewThread projectId="p1" />);
  expect(chosenAccount()).toBe("personal");
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
  type(screen.getByRole("textbox", { name: "Message" }), "Fix the build");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ agent, prompt: "Fix the build" })));
});
