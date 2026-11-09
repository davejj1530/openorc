// @vitest-environment jsdom
import type { RpcParams, ThreadSummary } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostContext } from "../connection/host-context";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { nativeProps } from "../test-fixtures/react-native";

/** The parent: a Claude thread in a worktree of openorc, on the plan mode, trusted and a work account. */
const parent = {
  id: "parent-1",
  projectId: "openorc",
  title: "Fix the flaky checkout test",
  agent: "claude",
  model: "opus",
  effort: "high",
  fastMode: false,
  mode: "plan",
  permissionMode: "trusted",
  claudeAccountId: "work",
  workspaceMode: "worktree",
  branch: "fix/checkout",
  prUrl: null,
  cloud: false,
} as unknown as ThreadSummary;

const mac = vi.hoisted(() => ({
  phone: null as FakeMac | null,
  shares: true,
  start: null as unknown as ReturnType<typeof vi.fn<(params: RpcParams<"threads.start">) => Promise<{ thread: { id: string } }>>>,
}));

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  const reads: Record<string, unknown> = {
    "threads.get": parent,
    "projects.list": [{ id: "openorc", name: "openorc", defaultBranch: "main" }],
    "agents.models": [{ id: "opus", label: "Opus", agent: "claude", isDefault: true, efforts: ["high"], defaultEffort: "high" }],
    "agents.availability": [{ id: "claude", state: "ready" }],
    "app.settings.get": { defaultWorkspaceMode: "worktree", defaultPermissionMode: "review", defaultHarness: null },
    "claude.accounts.list": [{ id: "work", name: "Work", state: "ready" }],
  };
  mac.phone = fakeMac((method, params) => (method === "threads.start" ? mac.start(params as RpcParams<"threads.start">) : Promise.resolve(reads[method])));
  Object.assign(mac.phone.module.link.connection, { shares: async () => mac.shares });
  return mac.phone.module;
});
vi.mock("react-native-keyboard-controller", () => ({ KeyboardStickyView: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("expo-router", () => ({
  router: { replace: vi.fn(), push: vi.fn(), back: vi.fn() },
  useLocalSearchParams: () => ({ threadId: "parent-1" }),
  useNavigation: () => ({ isFocused: () => true }),
}));
vi.mock("../composer/attachments", () => ({ pickImages: vi.fn(), attachImage: vi.fn() }));

const { NewSubthreadScreen } = await import("./NewSubthreadScreen");

beforeEach(() => {
  mac.phone!.saved.clear();
  mac.phone!.module.queryClient.clear();
  mac.shares = true;
  mac.start = vi.fn();
  vi.mocked(router.replace).mockClear();
});
afterEach(cleanup);

const start = () => screen.getByRole("button", { name: "Start" });
const write = (text: string) => act(() => (nativeProps.get(screen.getByLabelText("Message"))!.onChangeText as (text: string) => void)(text));

it("asks what to work on under the parent and where, and starts there on the parent's settings, then opens the subthread", async () => {
  render(<NewSubthreadScreen />, { wrapper: mac.phone!.wrapper });
  expect(await screen.findByText("What should we work on under Fix the flaky checkout test?")).toBeTruthy();
  expect(await screen.findByLabelText("Works in openorc · worktree")).toBeTruthy();
  write("Check the payment SDK changelog");
  await waitFor(() => expect(start().getAttribute("aria-disabled")).toBe("false"));
  mac.start.mockResolvedValue({ thread: { id: "child-1" } });
  await act(async () => fireEvent.click(start()));
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith({ pathname: "/thread/[id]", params: { id: "child-1" } }));
  expect(mac.start.mock.calls[0]![0]).toEqual({
    projectId: "openorc",
    parentThreadId: "parent-1",
    agent: "claude",
    model: "opus",
    effort: "high",
    fastMode: false,
    mode: "plan",
    permissionMode: "trusted",
    prompt: "Check the payment SDK changelog",
    attachments: [],
    claudeAccountId: "work",
  });
});

it("opens a subthread started on the cloud brain there", async () => {
  render(
    <HostContext.Provider value="brain-1">
      <NewSubthreadScreen />
    </HostContext.Provider>,
    { wrapper: mac.phone!.wrapper },
  );
  await screen.findByLabelText("Message");
  write("Try it in the cloud");
  await waitFor(() => expect(start().getAttribute("aria-disabled")).toBe("false"));
  mac.start.mockResolvedValue({ thread: { id: "child-2" } });
  await act(async () => fireEvent.click(start()));
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith({ pathname: "/thread/[id]", params: { id: "child-2", host: "brain-1" } }));
});

it("keeps the prompt and says why when the Mac refuses the start", async () => {
  render(<NewSubthreadScreen />, { wrapper: mac.phone!.wrapper });
  await screen.findByLabelText("Message");
  write("Look into the sandbox timeouts");
  await waitFor(() => expect(start().getAttribute("aria-disabled")).toBe("false"));
  mac.start.mockRejectedValue(new Error("Thread not found."));
  await act(async () => fireEvent.click(start()));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Thread not found.");
  expect(screen.getByLabelText("Message").textContent).toBe("Look into the sandbox timeouts");
  expect(router.replace).not.toHaveBeenCalled();
});

it("says at once that an older Mac cannot start subthreads from a phone, and holds Start", async () => {
  mac.shares = false;
  render(<NewSubthreadScreen />, { wrapper: mac.phone!.wrapper });
  expect(await screen.findByText("Update OpenOrc on your Mac to start subthreads from your phone.")).toBeTruthy();
  write("Look into it");
  expect(start().getAttribute("aria-disabled")).toBe("true");
  await act(async () => fireEvent.click(start()));
  expect(mac.start).not.toHaveBeenCalled();
});
