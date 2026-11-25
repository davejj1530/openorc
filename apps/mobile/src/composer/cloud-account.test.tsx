// @vitest-environment jsdom
import type { AccountStatus, ModelOption, RpcMethod, RpcParams, ThreadSummary } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { client } from "../client";
import { NewThreadScreen } from "../new-thread/NewThreadScreen";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { nativeProps } from "../test-fixtures/react-native";
import { useThreadCloudAccount } from "./cloud-account";
import { ComposerChips } from "./ComposerChips";
import { ModelSheet } from "./ModelSheet";
import { useShareSettings } from "./settings-bridge";

/** A person on OpenOrc Cloud with two Claude accounts and one signed out, and a Codex account, read by the phone's own session. */
const cloud = vi.hoisted(() => {
  const opus: ModelOption = { id: "opus", label: "Opus", agent: "claude", isDefault: true, efforts: ["high"], defaultEffort: "high" };
  const gpt: ModelOption = { id: "gpt-main", label: "GPT", agent: "codex", isDefault: true, efforts: ["high"], defaultEffort: "high" };
  const row = (agent: "claude" | "codex", id: string, name: string, more: { ended?: boolean; isDefault?: boolean } = {}) => ({
    agent,
    provider: agent === "claude" ? "anthropic" : "openai",
    label: "Max",
    ended: more.ended ?? false,
    id,
    name,
    isDefault: more.isDefault ?? false,
  });
  const status = {
    state: "signed-in",
    agentAccounts: true,
    signIns: [
      row("claude", "personal", "Personal", { isDefault: true }),
      row("claude", "work", "Work"),
      row("claude", "old", "Old", { ended: true }),
      row("codex", "plus", "Plus", { isDefault: true }),
    ],
  } as unknown as AccountStatus;
  const reads: Partial<Record<RpcMethod, unknown>> = {};
  const calls: { method: RpcMethod; params: unknown }[] = [];
  return { opus, gpt, status, reads, calls, phone: null as FakeMac | null, start: vi.fn<(params: RpcParams<"threads.start">) => Promise<{ thread: { id: string } }>>() };
});

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  cloud.phone = fakeMac((method, params) => {
    cloud.calls.push({ method, params });
    if (method === "threads.start") return cloud.start(params as RpcParams<"threads.start">);
    if (method === "projects.git") return Promise.resolve("ready");
    return Promise.resolve(cloud.reads[method]);
  });
  return cloud.phone.module;
});
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardStickyView: ({ children }: { children: ReactNode }) => <>{children}</>,
  useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: { value: 0 } }),
}));
vi.mock("expo-router", () => ({
  router: { replace: vi.fn(), push: vi.fn(), back: vi.fn() },
  useLocalSearchParams: () => ({ projectId: "cloud-project:h-notes", composerId: "new-thread" }),
  useNavigation: () => ({ isFocused: () => true }),
}));
vi.mock("./attachments", () => ({ pickImages: vi.fn(), attachImage: vi.fn() }));
vi.mock("../thread/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));

const personal = { id: "personal-me", kind: "personal" as const };

beforeEach(() => {
  cloud.phone!.saved.clear();
  cloud.phone!.module.queryClient.clear();
  cloud.calls.length = 0;
  cloud.start.mockReset();
  Object.assign(cloud.reads, {
    "account.status": cloud.status,
    "hosted.capabilities": { version: 1, features: { agentAccounts: { available: true } } },
    "cloudModels.catalog": { models: [cloud.opus, cloud.gpt] },
    "agents.models": [cloud.opus, cloud.gpt],
    "agents.availability": [
      { id: "claude", state: "ready" },
      { id: "codex", state: "ready" },
    ],
    "app.settings.get": { defaultWorkspaceMode: "worktree", defaultPermissionMode: "review", defaultHarness: "claude" },
    "claude.accounts.list": { defaultId: "claude-cli", accounts: [] },
    "projects.list": [],
    "spaces.status": {
      state: "ready",
      userId: "me",
      apiOrigin: "",
      personalSpaceId: personal.id,
      spaces: [personal],
      create: { allowed: false, reason: null },
      invitations: [],
      reach: "live",
      heardAt: 1,
      error: null,
    },
    "spaces.projects": [{ key: "cloud-project:h-notes", name: "notes-app", repo: "riley/notes-app", localProjectId: null, hostedProjectId: "h-notes", connected: true }],
  });
  act(() => cloud.phone!.cloud.hold(true));
});

afterEach(() => {
  cleanup();
  act(() => cloud.phone!.cloud.hold(false));
});

/** An open cloud thread, its settings built as ThreadScreen builds them. */
function CloudThread({ agent = "claude", model = "opus", accountId = "work", activity = "idle" }: { agent?: string; model?: string; accountId?: string | null; activity?: ThreadSummary["activity"] }) {
  const thread = {
    id: "open",
    projectId: "cloud-project:h-notes",
    agent,
    model,
    effort: "high",
    fastMode: false,
    mode: "act",
    permissionMode: "trusted",
    cloudAccountId: accountId,
    activity,
    owner: { brain: "hosted", reach: "live", heardAt: 0 },
  } as ThreadSummary;
  const settings = { ...client.useConversationSettings({ thread, activeRun: undefined }), cloudAccount: useThreadCloudAccount(thread), cloud: true };
  useShareSettings("new-thread", settings);
  return <ComposerChips composerId="new-thread" settings={settings} />;
}

const show = (thread: ReactNode) =>
  render(
    <>
      {thread}
      <ModelSheet />
    </>,
    { wrapper: cloud.phone!.wrapper },
  );

it("moves a cloud thread to another of the person's accounts for its agent, the signed-out one dimmed with why", async () => {
  show(<CloudThread />);
  fireEvent.click(await screen.findByRole("button", { name: "Claude account, Work" }));
  expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Personal", "Work"]);
  expect((screen.getByRole("button", { name: "Old · Signed out" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Personal" }));
  await waitFor(() => expect(cloud.calls).toContainEqual({ method: "threads.update", params: { id: "open", patch: { cloudAccountId: "personal" } } }));
});

it("checks the person's default where the thread names no account of theirs, as a teammate's", async () => {
  show(<CloudThread accountId="someone-elses" />);
  expect(await screen.findByRole("button", { name: "Claude account, Personal" })).toBeTruthy();
});

it("names a Codex thread's accounts in its own section, and holds the choice while a turn runs", async () => {
  show(<CloudThread agent="codex" model="gpt-main" accountId={null} activity="running" />);
  const menu = (await screen.findByRole("button", { name: "Account, Plus" })) as HTMLButtonElement;
  expect(menu.disabled).toBe(true);
  expect(screen.getByText("Switch accounts when this turn ends.")).toBeTruthy();
});

it("offers no account where the server keeps one sign-in per agent, or the phone holds no session of its own", async () => {
  cloud.reads["hosted.capabilities"] = { version: 1, features: {} };
  show(<CloudThread />);
  await screen.findByRole("button", { name: "Model, Opus" });
  expect(screen.queryByRole("button", { name: /account/ })).toBeNull();
  cleanup();
  cloud.reads["hosted.capabilities"] = { version: 1, features: { agentAccounts: { available: true } } };
  act(() => cloud.phone!.cloud.hold(false));
  cloud.phone!.module.queryClient.clear();
  cloud.calls.length = 0;
  show(<CloudThread />);
  await screen.findByRole("button", { name: "Model, Opus" });
  expect(screen.queryByRole("button", { name: /account/ })).toBeNull();
  expect(cloud.calls.map((call) => call.method)).not.toContain("account.status");
});

it("starts a new cloud thread on the account chosen, offering none of the Mac's Claude accounts", async () => {
  cloud.reads["claude.accounts.list"] = {
    defaultId: "claude-cli",
    accounts: [
      { id: "claude-cli", name: "Existing CLI login", kind: "cli", enabled: true, createdAt: 1, status: "ready", email: null, organization: null, message: null },
      { id: "mac-work", name: "Mac Work", kind: "managed", enabled: true, createdAt: 1, status: "ready", email: null, organization: null, message: null },
    ],
  };
  cloud.start.mockResolvedValue({ thread: { id: "cloud-thread" } });
  render(
    <>
      <NewThreadScreen />
      <ModelSheet />
    </>,
    { wrapper: cloud.phone!.wrapper },
  );
  fireEvent.click(await screen.findByRole("button", { name: "Claude account, Personal" }));
  expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Personal", "Work"]);
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Work" }));
  await screen.findByRole("button", { name: "Claude account, Work" });
  act(() => (nativeProps.get(screen.getByLabelText("Message"))!.onChangeText as (text: string) => void)("Search the attachments"));
  const start = screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;
  await waitFor(() => expect(start.disabled).toBe(false));
  await act(async () => fireEvent.click(start));
  expect(cloud.start.mock.calls[0]![0]).toMatchObject({ projectId: "cloud-project:h-notes", hosted: true, cloudAccountId: "work" });
  expect(cloud.start.mock.calls[0]![0]).not.toHaveProperty("claudeAccountId");
});
