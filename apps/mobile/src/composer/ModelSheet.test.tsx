// @vitest-environment jsdom
import type { ClaudeAccountConnection, ModelOption, RpcMethod, RpcParams } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NewThreadScreen } from "../new-thread/NewThreadScreen";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { nativeProps } from "../test-fixtures/react-native";
import { ModelSheet } from "./ModelSheet";

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
  return { account, claude, codex, reads, calls, phone: null as FakeMac | null, start: vi.fn<(params: RpcParams<"threads.start">) => Promise<{ thread: { id: string } }>>() };
});

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method, params) => {
    mac.calls.push({ method, params });
    if (method === "threads.start") return mac.start(params as RpcParams<"threads.start">);
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
}

beforeEach(() => {
  mac.phone!.saved.clear();
  mac.phone!.module.queryClient.clear();
  mac.start.mockReset();
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
  await waitFor(() => expect(screen.getByRole("button", { name: /^Model, / })).toBeTruthy());
}

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
