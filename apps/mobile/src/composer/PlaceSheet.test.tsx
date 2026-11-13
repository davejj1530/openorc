// @vitest-environment jsdom
import type { CloudOffer, ModelOption, RpcMethod, RpcParams } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NewThreadScreen } from "../new-thread/NewThreadScreen";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { nativeProps } from "../test-fixtures/react-native";
import { PlaceSheet } from "./PlaceSheet";

/** A Mac with Claude and Codex signed in, the cloud offered as a test sets it, and a start the test answers. */
const mac = vi.hoisted(() => {
  const claude: ModelOption = { id: "opus", label: "Opus", agent: "claude", isDefault: true, efforts: ["high"], defaultEffort: "high" };
  const reads: Partial<Record<RpcMethod, unknown>> = {};
  return { claude, reads, phone: null as FakeMac | null, start: vi.fn<(params: RpcParams<"threads.start">) => Promise<{ thread: { id: string } }>>() };
});

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method, params) => {
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

function macState(offer: CloudOffer) {
  mac.reads["projects.list"] = [{ id: "openorc", name: "openorc", defaultBranch: "main" }];
  mac.reads["agents.models"] = [mac.claude];
  mac.reads["agents.availability"] = [{ id: "claude", state: "ready" }];
  mac.reads["app.settings.get"] = { defaultWorkspaceMode: "worktree", defaultPermissionMode: "review", defaultHarness: "claude" };
  mac.reads["claude.accounts.list"] = { defaultId: "claude-cli", accounts: [] };
  mac.reads["cloud.offer"] = offer;
}

beforeEach(() => {
  mac.phone!.saved.clear();
  mac.phone!.module.queryClient.clear();
  mac.start.mockReset();
});
afterEach(cleanup);

/** The new thread's screen with its place sheet open over it. */
function open() {
  render(
    <>
      <NewThreadScreen />
      <PlaceSheet />
    </>,
    { wrapper: mac.phone!.wrapper },
  );
}

it("starts a thread in the cloud chosen beside the project picker", async () => {
  macState({ offered: true, provider: "vercel" });
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Runs on, This Mac" }));
  expect(router.push).toHaveBeenCalledWith({ pathname: "/place", params: { composerId: "new-thread" } });
  expect(screen.getByText("A Vercel sandbox of its own; its changes arrive in a worktree on the Mac")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: /^Cloud/ }));
  await screen.findByRole("button", { name: "Runs on, Cloud" });

  act(() => (nativeProps.get(screen.getByLabelText("Message"))!.onChangeText as (text: string) => void)("Fix the build"));
  mac.start.mockResolvedValue({ thread: { id: "thread-1" } });
  await waitFor(() => expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(false));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
  expect(mac.start.mock.calls[0]![0]).toMatchObject({ projectId: "openorc", workspaceMode: "worktree", cloud: true });
});

it("shows no place while the Mac offers no cloud", async () => {
  macState({ offered: false, provider: null });
  open();
  await screen.findByRole("button", { name: /^Model, / });
  await act(async () => undefined);
  expect(screen.queryByRole("button", { name: /^Runs on/ })).toBeNull();
});
