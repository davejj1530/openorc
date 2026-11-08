import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClaudeAccountConnection, ClaudeAccounts, Project, ProjectClaudeAccounts } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { ProjectSettings } from "./project-settings";

const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../lib/rpc", () => ({ core: { call: mocks.call, onReady: () => {}, onPush: () => () => {} } }));

const account = (id: string, name: string, patch: Partial<ClaudeAccountConnection> = {}): ClaudeAccountConnection => ({
  id,
  name,
  kind: "managed",
  createdAt: 1,
  enabled: true,
  status: "ready",
  email: `${id}@example.test`,
  organization: null,
  message: null,
  ...patch,
});
let project: Project;
let accounts: ClaudeAccounts;
let appAutoSwitch: boolean;
/** What the host says to the next save, when it refuses it. */
let refuse: string | null;
let release: (() => void) | null;

beforeEach(() => {
  queryClient.clear();
  appAutoSwitch = false;
  refuse = null;
  release = null;
  accounts = {
    defaultId: "work",
    accounts: [
      account("claude-cli", "Existing CLI login", { kind: "cli", status: "signed_out", email: null }),
      account("work", "Work"),
      account("personal", "Personal"),
      account("off", "Off", { enabled: false, status: "disabled" }),
    ],
  };
  project = {
    id: "p",
    name: "block8-workspace",
    rootPath: "/projects/block8",
    gitRemote: null,
    defaultBranch: "main",
    settings: { setupScript: null, worktreeInclude: [".env"], branchPrefix: "openorc", detectedConfigs: [], claudeAccounts: null },
    createdAt: 1,
    updatedAt: 1,
  };
  mocks.call.mockReset().mockImplementation(async (method: string, params: { settings?: Partial<Project["settings"]> }) => {
    if (method === "projects.get") return structuredClone(project);
    if (method === "claude.accounts.list") return structuredClone(accounts);
    if (method === "app.settings.get") return { claudeAccountAutoSwitch: appAutoSwitch };
    if (method === "projects.updateSettings") {
      if (release) await new Promise<void>((resolve) => (release = resolve));
      if (refuse) throw new Error(refuse);
      project = { ...project, settings: { ...project.settings, ...params.settings } };
      return structuredClone(project);
    }
    throw new Error(`Unexpected fixture method: ${method}`);
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

function mount() {
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectSettings projectId="p" />
    </QueryClientProvider>,
  );
}
const section = () => screen.getByRole("region", { name: "Claude accounts" });
const toggle = (name: string) => within(section()).getByRole("switch", { name: new RegExp(`^${name}`) });
const box = (name: string) => within(section()).getByRole("checkbox", { name: new RegExp(`^${name}`) });
const saved = () => mocks.call.mock.calls.filter(([method]) => method === "projects.updateSettings").map(([, params]) => params.settings.claudeAccounts as ProjectClaudeAccounts);
const own = (patch: Partial<ProjectClaudeAccounts> = {}): ProjectClaudeAccounts => ({ only: true, accountIds: ["work"], defaultId: "work", autoSwitch: false, ...patch });

it("follows the app's accounts until turned on, then starts with the app's default account, apart from the worktree card", async () => {
  appAutoSwitch = true;
  mount();
  await screen.findByText("Choose which accounts threads in this project can use. Other projects keep the app's accounts.");
  await within(section()).findByText("Off. Threads use any enabled account, and switching at usage limits follows the app setting (On).");
  expect(within(section()).queryByRole("checkbox")).toBeNull();
  await waitFor(() => expect(toggle("Use only selected accounts")).toMatchObject({ disabled: false }));
  fireEvent.click(toggle("Use only selected accounts"));
  await waitFor(() => expect(saved()).toEqual([{ only: true, accountIds: ["work"], defaultId: "work", autoSwitch: true }]));
  expect(within(section()).getByText("Threads in block8-workspace start, switch and continue on these accounts only.")).toBeTruthy();
  // Enabled accounts are offered; the disabled one is not.
  expect(
    within(section())
      .getAllByRole("checkbox")
      .map((each) => each.closest("label")?.textContent),
  ).toEqual([expect.stringContaining("Existing CLI login"), expect.stringContaining("Work"), expect.stringContaining("Personal")]);
  expect(box("Work")).toMatchObject({ checked: true, disabled: true });
  expect(within(section()).getByText("Default")).toBeTruthy();
  expect(within(section()).getAllByText("Connected")).toHaveLength(2);
  expect(within(section()).getByText("Sign in needed")).toBeTruthy();
  expect(toggle("Switch accounts at usage limits")).toMatchObject({ disabled: true });
  expect(within(section()).getByText("Select two or more accounts to switch")).toBeTruthy();
  expect(mocks.call).not.toHaveBeenCalledWith("projects.updateSettings", expect.objectContaining({ settings: expect.objectContaining({ branchPrefix: expect.anything() }) }));
});

it("chooses accounts, a default and the switch at usage limits, saving each at once", async () => {
  project.settings.claudeAccounts = own();
  mount();
  fireEvent.click(await waitFor(() => box("Personal")));
  await waitFor(() => expect(saved().at(-1)).toEqual(own({ accountIds: ["work", "personal"] })));
  fireEvent.click(within(section()).getByRole("button", { name: "Make default" }));
  await waitFor(() => expect(saved().at(-1)).toEqual(own({ accountIds: ["work", "personal"], defaultId: "personal" })));
  expect(within(section()).getByText("When a thread's account reaches its limit, it continues on the selected account with the most 5-hour usage left. Overrides the app setting (Off).")).toBeTruthy();
  fireEvent.click(toggle("Switch accounts at usage limits"));
  await waitFor(() => expect(saved().at(-1)?.autoSwitch).toBe(true));
  // Taking out the default moves it to the account that is left, which then cannot be taken out.
  fireEvent.click(box("Personal"));
  await waitFor(() => expect(saved().at(-1)).toEqual(own({ accountIds: ["work"], defaultId: "work", autoSwitch: true })));
  expect(box("Work")).toMatchObject({ checked: true, disabled: true });
  expect(toggle("Switch accounts at usage limits")).toMatchObject({ disabled: true });
});

it("keeps the selection while turned off and brings it back, without accounts removed since", async () => {
  project.settings.claudeAccounts = own({ accountIds: ["personal", "gone"], defaultId: "gone", autoSwitch: true });
  mount();
  await waitFor(() => expect(toggle("Use only selected accounts")).toMatchObject({ disabled: false }));
  fireEvent.click(toggle("Use only selected accounts"));
  await waitFor(() => expect(saved().at(-1)).toEqual(own({ only: false, accountIds: ["personal", "gone"], defaultId: "gone", autoSwitch: true })));
  expect(within(section()).queryByRole("checkbox")).toBeNull();
  fireEvent.click(toggle("Use only selected accounts"));
  await waitFor(() => expect(saved().at(-1)).toEqual(own({ accountIds: ["personal"], defaultId: "personal", autoSwitch: true })));
  expect(box("Personal")).toMatchObject({ checked: true });
});

it("shows a change before the host answers, and puts it back with the host's reason when refused", async () => {
  project.settings.claudeAccounts = own();
  mount();
  await waitFor(() => box("Personal"));
  refuse = "One of these Claude accounts is no longer available. Choose again.";
  release = () => {};
  fireEvent.click(box("Personal"));
  await waitFor(() => expect(box("Personal")).toMatchObject({ checked: true }));
  expect(box("Work")).toMatchObject({ disabled: true });
  act(() => release?.());
  expect(await within(section()).findByRole("alert")).toMatchObject({ textContent: "One of these Claude accounts is no longer available. Choose again." });
  expect(box("Personal")).toMatchObject({ checked: false });
});
