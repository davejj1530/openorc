import type { Project, RpcResults, Thread } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRouter } from "../lib/router";

const start = vi.fn();
let accounts: RpcResults["claude.accounts.list"] | undefined;
let project: Project | null;
let parent: Thread;
const codexParent = {
  id: "home",
  projectId: "p1",
  title: "Landing page",
  agent: "codex",
  model: "codex-model",
  effort: "high",
  fastMode: false,
  mode: "act",
  permissionMode: "trusted",
  claudeAccountId: null,
  workingDirectory: null,
  worktreePath: "/worktrees/landing",
  branch: "openorc/landing",
} as unknown as Thread;

vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpc: (method: string) => {
    const data: Record<string, unknown> = { "threads.get": parent, "claude.accounts.list": accounts, "projects.get": project };
    return { data: data[method], error: null, isPending: false, refetch: vi.fn() };
  },
  useRpcMutation: () => ({ mutateAsync: start, reset: vi.fn(), isPending: false, error: null }),
}));
vi.mock("../lib/rpc", () => ({ core: { call: async () => null, onReady: () => () => {}, onPush: () => () => {} } }));
vi.mock("../lib/skill-commands", () => ({ useSkillCommands: () => ({ commands: [], onCommandsWanted: () => {} }) }));
vi.mock("../components/TopBar", () => ({ TopBar: ({ children }: { children: React.ReactNode }) => <header>{children}</header> }));
// The picker's own rows are its tests'; here, the Claude accounts the screen hands it, and what choosing one does.
vi.mock("../components/ModelPicker", () => ({
  ModelPicker: () => <button type="button">Choose model</button>,
  ComposerModelPicker: ({ accounts }: { accounts?: PickerAccounts }) => (
    <>
      <button type="button">Choose model</button>
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
import { NewSubthread } from "./NewSubthread";

const claudeParent = { ...codexParent, agent: "claude", model: "claude-model", claudeAccountId: "work" } as Thread;
const send = (text: string) => {
  const message = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
  fireEvent.change(message, { target: { value: text } });
  fireEvent.keyDown(message, { key: "Enter", code: "Enter" });
};

beforeEach(() => {
  localStorage.clear();
  parent = codexParent;
  project = { id: "p1", name: "Landing", settings: {} } as Project;
  accounts = {
    defaultId: "personal",
    accounts: ["personal", "work", "client"].map((id, createdAt) => ({ id, name: id, kind: "managed", enabled: true, createdAt, status: "ready", email: null, organization: null, message: null })),
  };
  start.mockReset().mockResolvedValue({ thread: { id: "sub-1" }, run: null });
  useRouter.getState().navigate({ view: "newsubthread", parentId: "home" });
});
afterEach(cleanup);

it("starts the subthread under its parent on the parent's settings, then opens it", async () => {
  render(
    <StrictMode>
      <NewSubthread parentId="home" />
    </StrictMode>,
  );
  expect(screen.getByRole("heading").textContent).toBe("What should we work on under Landing page?");
  const message = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
  fireEvent.change(message, { target: { value: "Fix the flaky signup test" } });
  fireEvent.keyDown(message, { key: "Enter", code: "Enter" });
  await waitFor(() => expect(useRouter.getState().route).toEqual({ view: "thread", threadId: "sub-1" }));
  expect(start).toHaveBeenCalledWith({
    projectId: "p1",
    parentThreadId: "home",
    agent: "codex",
    model: "codex-model",
    effort: "high",
    fastMode: false,
    mode: "act",
    permissionMode: "trusted",
    prompt: "Fix the flaky signup test",
    attachments: [],
    // The parent had no account, so the project's default goes along.
    claudeAccountId: "personal",
  });
  expect(localStorage.getItem("openorc.draft.subthread.home")).toBe(JSON.stringify({ prompt: "" }));
});

it("starts a Claude subthread on the parent's account, or on the one chosen in the picker", async () => {
  parent = claudeParent;
  render(<NewSubthread parentId="home" />);
  expect(chosenAccount()).toBe("work");
  expect(offeredAccounts()).toEqual(["personal", "work", "client"]);
  fireEvent.click(accountGroup().getByRole("button", { name: "client" }));
  expect(chosenAccount()).toBe("client");
  send("Use the client account");
  await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ parentThreadId: "home", agent: "claude", claudeAccountId: "client" })));
});

it("offers only the accounts the project uses, starting on its default when the parent's is not one of them", async () => {
  parent = claudeParent;
  project = { ...project!, settings: { claudeAccounts: { only: true, accountIds: ["personal", "client"], defaultId: "client", autoSwitch: false } } } as Project;
  render(<NewSubthread parentId="home" />);
  expect(offeredAccounts()).toEqual(["personal", "client"]);
  expect(chosenAccount()).toBe("client");
  send("Use the project's account");
  await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ claudeAccountId: "client" })));
});
