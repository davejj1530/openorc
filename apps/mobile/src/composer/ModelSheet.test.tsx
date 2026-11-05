// @vitest-environment jsdom
import type { ClaudeAccountConnection, ModelOption, RpcMethod, RpcParams, ThreadSummary } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hostClient } from "../client";
import { NewThreadScreen } from "../new-thread/NewThreadScreen";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { nativeProps } from "../test-fixtures/react-native";
import { useThreadClaudeAccount } from "./claude-account";
import { ComposerChips } from "./ComposerChips";
import { ModelSheet } from "./ModelSheet";
import { useShareSettings } from "./settings-bridge";

/** A Mac with Claude signed in on its CLI login and a Work account, one account turned off, and a start the test answers. */
const mac = vi.hoisted(() => {
  const account = (id: string, name: string, more: Partial<ClaudeAccountConnection> = {}): ClaudeAccountConnection => ({
    id,
    name,
    kind: id === "claude-cli" ? "cli" : "managed",
    enabled: true,
    createdAt: 1,
    status: "ready",
    email: null,
    organization: null,
    message: null,
    ...more,
  });
  const claude: ModelOption = { id: "opus", label: "Opus", agent: "claude", isDefault: true, efforts: ["high"], defaultEffort: "high" };
  const codex: ModelOption = { id: "gpt-main", label: "GPT", agent: "codex", isDefault: true, efforts: ["high"], defaultEffort: "high" };
  const reads: Partial<Record<RpcMethod, unknown>> = {};
  const calls: { method: RpcMethod; params: unknown }[] = [];
  return {
    account,
    claude,
    codex,
    reads,
    calls,
    phone: null as FakeMac | null,
    start: vi.fn<(params: RpcParams<"threads.start">) => Promise<{ thread: { id: string } }>>(),
    switchAccount: vi.fn<(params: RpcParams<"threads.switchClaudeAccount">) => Promise<unknown>>(),
  };
});

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method, params) => {
    mac.calls.push({ method, params });
    if (method === "threads.start") return mac.start(params as RpcParams<"threads.start">);
    if (method === "threads.switchClaudeAccount") return mac.switchAccount(params as RpcParams<"threads.switchClaudeAccount">);
    if (method === "projects.git") return Promise.resolve("ready");
    return Promise.resolve(mac.reads[method]);
  });
  return mac.phone.module;
});
vi.mock("react-native-keyboard-controller", () => ({ KeyboardStickyView: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("expo-router", () => ({
  router: { replace: vi.fn(), push: vi.fn(), back: vi.fn() },
  useLocalSearchParams: () => ({ projectId: "openorc", composerId: "new-thread" }),
  useNavigation: () => ({ isFocused: () => true }),
}));
vi.mock("./attachments", () => ({ pickImages: vi.fn(), attachImage: vi.fn() }));

function macState({ harness = "claude", accounts }: { harness?: "claude" | "codex"; accounts: ClaudeAccountConnection[] }) {
  mac.reads["projects.list"] = [{ id: "openorc", name: "openorc", defaultBranch: "main" }];
  mac.reads["agents.models"] = [mac.claude, mac.codex];
  mac.reads["agents.availability"] = [
    { id: "claude", state: "ready" },
    { id: "codex", state: "ready" },
  ];
  mac.reads["app.settings.get"] = { defaultWorkspaceMode: "worktree", defaultPermissionMode: "review", defaultHarness: harness };
  mac.reads["claude.accounts.list"] = { defaultId: "claude-cli", accounts };
  mac.reads["cloud.offer"] = { offered: false, provider: null };
}

beforeEach(() => {
  mac.phone!.saved.clear();
  mac.phone!.module.queryClient.clear();
  mac.start.mockReset();
  mac.switchAccount.mockReset().mockResolvedValue({});
  mac.calls.length = 0;
});
afterEach(cleanup);

/** The new thread's screen with its Model sheet open over it. */
async function open() {
  render(
    <>
      <NewThreadScreen />
      <ModelSheet />
    </>,
    { wrapper: mac.phone!.wrapper },
  );
  await waitFor(() => expect(screen.getByRole("button", { name: /^Model, (?!Model$)/ })).toBeTruthy());
}

const client = hostClient(null);
const write = (prompt: string) => act(() => (nativeProps.get(screen.getByLabelText("Message"))!.onChangeText as (text: string) => void)(prompt));
const start = () => act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));

it("starts a Claude thread on the account chosen in the Model sheet, with that account's models", async () => {
  macState({
    accounts: [
      mac.account("claude-cli", "Existing CLI login"),
      mac.account("work", "Work"),
      mac.account("old", "Old", { enabled: false, status: "disabled" }),
      mac.account("q6", "Q6", { status: "signed_out" }),
    ],
  });
  await open();
  fireEvent.click(await screen.findByRole("button", { name: "Claude account, Existing CLI login" }));

  // An account the Mac cannot run is listed with why, outside the choices.
  expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Existing CLI login", "Work"]);
  for (const name of ["Old · Turned off", "Q6 · Signed out"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Work" }));
  await screen.findByRole("button", { name: "Claude account, Work" });
  await waitFor(() => expect(mac.calls).toContainEqual({ method: "agents.models", params: { claudeAccountId: "work" } }));

  write("Fix the build");
  mac.start.mockResolvedValue({ thread: { id: "thread-1" } });
  await waitFor(() => expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(false));
  await start();
  expect(mac.start.mock.calls[0]![0]).toMatchObject({ agent: "claude", model: "opus", claudeAccountId: "work" });
});

it("starts on the Mac's default account until one is chosen", async () => {
  macState({ accounts: [mac.account("claude-cli", "Existing CLI login"), mac.account("work", "Work")] });
  await open();
  await screen.findByRole("button", { name: "Claude account, Existing CLI login" });
  write("Fix the build");
  mac.start.mockResolvedValue({ thread: { id: "thread-1" } });
  await waitFor(() => expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(false));
  await start();
  expect(mac.start.mock.calls[0]![0]).not.toHaveProperty("claudeAccountId");
});

it.each([
  { name: "a Codex model", harness: "codex", model: "GPT", accounts: ["claude-cli", "work"] },
  { name: "a Mac with one Claude account", harness: "claude", model: "Opus", accounts: ["claude-cli"] },
] as const)("offers no account choice for $name", async ({ harness, model, accounts }) => {
  macState({ harness, accounts: accounts.map((id) => mac.account(id, id)) });
  await open();
  await screen.findByRole("button", { name: `Model, ${model}` });
  await waitFor(() => expect(mac.calls.some((call) => call.method === "claude.accounts.list")).toBe(true));
  await act(async () => undefined);
  expect(screen.queryByRole("button", { name: /^Claude account/ })).toBeNull();
});

it.each(["claude", "codex"] as const)("starts a %s thread with Fast requested from the model sheet", async (harness) => {
  macState({ harness, accounts: [mac.account("claude-cli", "Claude")] });
  mac.reads["agents.models"] = [mac.claude, mac.codex].map((model) => ({ ...model, fastMode: { supported: true } }));
  await open();
  const toggle = screen.getByRole("switch", { name: "Fast mode" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.hasAttribute("disabled")).toBe(false);
  fireEvent.click(toggle);
  await screen.findByRole("button", { name: /Fast mode requested/ });
  expect(toggle.getAttribute("aria-checked")).toBe("true");

  write("Fix the build");
  mac.start.mockResolvedValue({ thread: { id: "thread-1" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Start" }).hasAttribute("disabled")).toBe(false));
  await start();
  expect(mac.start.mock.calls[0]![0]).toMatchObject({ agent: harness, fastMode: true });
});

it.each([
  { capability: { supported: false, reason: "Usage credits are off for this account." }, reason: "Usage credits are off for this account." },
  { capability: undefined, reason: "Fast mode availability was not reported. Try Refresh models." },
])("keeps Fast off and explains why when the catalog says $reason", async ({ capability, reason }) => {
  macState({ accounts: [mac.account("claude-cli", "Claude")] });
  mac.reads["agents.models"] = [{ ...mac.claude, fastMode: capability }];
  await open();
  expect(screen.getByRole("switch", { name: "Fast mode" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText(reason)).toBeTruthy();
  fireEvent.click(screen.getByRole("switch", { name: "Fast mode" }));
  expect(screen.queryByRole("button", { name: /Fast mode requested/ })).toBeNull();
});

it("clears Fast when choosing a model that cannot run it", async () => {
  macState({ accounts: [mac.account("claude-cli", "Claude")] });
  mac.reads["agents.models"] = [
    { ...mac.claude, fastMode: { supported: true } },
    { ...mac.claude, id: "standard", label: "Standard", isDefault: false, fastMode: { supported: false, reason: "Standard does not support Fast mode." } },
  ];
  await open();
  fireEvent.click(screen.getByRole("switch", { name: "Fast mode" }));
  await screen.findByRole("button", { name: /Fast mode requested/ });
  fireEvent.click(screen.getByRole("radio", { name: "Standard" }));
  await screen.findByRole("button", { name: "Model, Standard" });
  expect(screen.getByRole("switch", { name: "Fast mode" }).getAttribute("aria-checked")).toBe("false");
  expect(screen.getByRole("switch", { name: "Fast mode" }).hasAttribute("disabled")).toBe(true);
});

it("waits for the chosen account's Fast eligibility instead of using the previous account's", async () => {
  macState({ accounts: [mac.account("claude-cli", "Claude"), mac.account("work", "Work")] });
  mac.reads["agents.models"] = [{ ...mac.claude, fastMode: { supported: true } }];
  await open();
  expect(screen.getByRole("switch", { name: "Fast mode" }).hasAttribute("disabled")).toBe(false);
  const work = Promise.withResolvers<ModelOption[]>();
  mac.reads["agents.models"] = work.promise;
  fireEvent.click(screen.getByRole("button", { name: "Claude account, Claude" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Work" }));
  await screen.findByText("Loading Fast mode availability…");
  expect(screen.getByRole("switch", { name: "Fast mode" }).hasAttribute("disabled")).toBe(true);
  await act(async () => work.resolve([{ ...mac.claude, fastMode: { supported: false, reason: "Fast is turned off for Work." } }]));
  await screen.findByText("Fast is turned off for Work.");
  expect(screen.getByRole("switch", { name: "Fast mode" }).hasAttribute("disabled")).toBe(true);
});

/** An existing thread uses the same settings hook as ThreadScreen, keeping its own account. */
function SavedThread() {
  const settings = {
    ...client.useConversationSettings({
      thread: { id: "saved", agent: "claude", model: "opus", effort: "high", fastMode: true, mode: "act", permissionMode: "trusted" },
      activeRun: undefined,
    }),
    claudeAccountId: "work",
  };
  useShareSettings("new-thread", settings);
  return <ComposerChips composerId="new-thread" settings={settings} />;
}

it("keeps Fast configurable for a saved legacy model even though it is omitted from the model list", async () => {
  mac.reads["agents.models"] = [{ ...mac.claude, legacy: true, fastMode: { supported: true } }];
  render(
    <>
      <SavedThread />
      <ModelSheet />
    </>,
    { wrapper: mac.phone!.wrapper },
  );
  await screen.findByRole("button", { name: "Model, Opus, Fast mode requested" });
  expect(screen.queryByRole("radio", { name: "Opus" })).toBeNull();
  const toggle = screen.getByRole("switch", { name: "Fast mode" });
  fireEvent.click(toggle);
  await screen.findByRole("button", { name: "Model, Opus" });
  expect(toggle.hasAttribute("disabled")).toBe(false);
  fireEvent.click(toggle);
  await screen.findByRole("button", { name: "Model, Opus, Fast mode requested" });
});

it("uses an existing thread's account and lets its saved Fast request be turned off after eligibility is lost", async () => {
  mac.reads["agents.models"] = [{ ...mac.claude, fastMode: { supported: false, reason: "Work has no Fast credits." } }];
  render(
    <>
      <SavedThread />
      <ModelSheet />
    </>,
    { wrapper: mac.phone!.wrapper },
  );
  await screen.findByRole("button", { name: "Model, Opus, Fast mode unavailable" });
  expect(mac.calls).toContainEqual({ method: "agents.models", params: { claudeAccountId: "work" } });
  expect(screen.queryByRole("button", { name: /^Claude account/ })).toBeNull();
  const toggle = screen.getByRole("switch", { name: "Fast mode" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(toggle.hasAttribute("disabled")).toBe(false);
  fireEvent.click(toggle);
  await screen.findByRole("button", { name: "Model, Opus" });
  await waitFor(() => expect(mac.calls).toContainEqual({ method: "threads.update", params: { id: "saved", patch: { agent: "claude", model: "opus", effort: "high", fastMode: false } } }));
  expect(toggle.hasAttribute("disabled")).toBe(true);
});

/** An open Claude thread on Work, its settings built as ThreadScreen builds them. */
function OpenThread({ activity = "idle" }: { activity?: ThreadSummary["activity"] }) {
  const thread = { id: "open", agent: "claude", model: "opus", effort: "high", fastMode: false, mode: "act", permissionMode: "trusted", claudeAccountId: "work", activity } as ThreadSummary;
  const settings = { ...client.useConversationSettings({ thread, activeRun: undefined }), claudeAccountId: "work", claudeAccount: useThreadClaudeAccount(thread) };
  useShareSettings("new-thread", settings);
  return <ComposerChips composerId="new-thread" settings={settings} />;
}

const accounts = () => [mac.account("claude-cli", "Existing CLI login"), mac.account("work", "Work"), mac.account("q6", "Q6", { status: "signed_out" })];

it("moves an open Claude thread to another signed-in account from its Model sheet, and says when that fails", async () => {
  macState({ accounts: accounts() });
  mac.switchAccount.mockRejectedValueOnce(new Error("Fast is turned off for Existing CLI login."));
  render(
    <>
      <OpenThread />
      <ModelSheet />
    </>,
    { wrapper: mac.phone!.wrapper },
  );
  fireEvent.click(await screen.findByRole("button", { name: "Claude account, Work" }));
  expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Existing CLI login", "Work"]);
  expect((screen.getByRole("button", { name: "Q6 · Signed out" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Existing CLI login" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Couldn’t switch accounts. Fast is turned off for Existing CLI login.");
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Existing CLI login" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(mac.switchAccount.mock.calls.map(([params]) => params)).toEqual([
    { id: "open", claudeAccountId: "claude-cli" },
    { id: "open", claudeAccountId: "claude-cli" },
  ]);
});

it("holds an open thread's account while its turn runs", async () => {
  macState({ accounts: accounts() });
  render(
    <>
      <OpenThread activity="running" />
      <ModelSheet />
    </>,
    { wrapper: mac.phone!.wrapper },
  );
  const menu = (await screen.findByRole("button", { name: "Claude account, Work" })) as HTMLButtonElement;
  expect([menu.disabled, screen.getByText("Switch accounts when this turn ends.").tagName]).toEqual([true, expect.any(String)]);
  fireEvent.click(menu);
  expect(screen.queryByRole("menuitemradio")).toBeNull();
  expect(mac.switchAccount).not.toHaveBeenCalled();
});
