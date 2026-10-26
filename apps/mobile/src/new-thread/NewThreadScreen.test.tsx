// @vitest-environment jsdom
import type { ProjectGit, RpcMethod, RpcParams } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { attachImage, pickImages } from "../composer/attachments";
import type { DraftImage } from "../composer/drafts";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { nativeProps } from "../test-fixtures/react-native";
import { NewThreadScreen } from "./NewThreadScreen";

/**
 * A Mac with a repository, two folders without git (a test gives `later` its first commit while the Mac's project row
 * still names no default branch), and a start the test answers; `focused` is whether the screen is on top.
 */
const mac = vi.hoisted(() => {
  const git: Record<string, ProjectGit> = {};
  const reads: Partial<Record<RpcMethod, unknown>> = {
    "projects.list": [
      { id: "openorc", name: "openorc", defaultBranch: "main" },
      { id: "notes", name: "notes", defaultBranch: null },
      { id: "later", name: "later", defaultBranch: null },
    ],
    "agents.models": [{ id: "gpt-main", label: "GPT", agent: "codex", isDefault: true, efforts: ["high"], defaultEffort: "high" }],
    "agents.availability": [{ id: "codex", state: "ready" }],
    "app.settings.get": { defaultWorkspaceMode: "worktree", defaultPermissionMode: "review", defaultHarness: null },
  };
  return { git, reads, focused: true, phone: null as FakeMac | null, start: vi.fn<(params: RpcParams<"threads.start">) => Promise<{ thread: { id: string } }>>() };
});

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method, params) => {
    if (method === "threads.start") return mac.start(params as RpcParams<"threads.start">);
    if (method === "projects.git") return Promise.resolve(mac.git[(params as RpcParams<"projects.git">).id]);
    return Promise.resolve(mac.reads[method]);
  });
  return mac.phone.module;
});
vi.mock("react-native-keyboard-controller", () => ({ KeyboardStickyView: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("expo-router", () => ({
  router: { replace: vi.fn() },
  useLocalSearchParams: () => ({ projectId: "openorc" }),
  useNavigation: () => ({ isFocused: () => mac.focused }),
}));
vi.mock("../composer/attachments", () => ({ pickImages: vi.fn(), attachImage: vi.fn() }));

beforeEach(() => {
  mac.phone!.saved.clear();
  mac.phone!.module.queryClient.clear();
  mac.start.mockReset();
  mac.focused = true;
  Object.assign(mac.git, { openorc: "ready", notes: "none", later: "none" });
  vi.mocked(router.replace).mockClear();
});
afterEach(cleanup);

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const project = (name: string) => screen.getByRole("radio", { name }) as HTMLButtonElement;

/** Opens the screen from the openorc heading's plus and writes the prompt once Start can go. */
async function openAndWrite(prompt: string) {
  render(<NewThreadScreen />, { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(project("notes")).toBeTruthy());
  act(() => (nativeProps.get(screen.getByLabelText("Message"))!.onChangeText as (text: string) => void)(prompt));
  await waitFor(() => expect(button("Start").getAttribute("aria-disabled")).toBe("false"));
}

it("swaps itself for the started thread", async () => {
  await openAndWrite("Fix the build");
  mac.start.mockResolvedValue({ thread: { id: "thread-1" } });
  await act(async () => fireEvent.click(button("Start")));
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith({ pathname: "/thread/[id]", params: { id: "thread-1" } }));
  expect(mac.start.mock.calls[0]![0]).toMatchObject({ projectId: "openorc", workspaceMode: "worktree" });
});

it("leaves the person where they went when the Mac answers after they left", async () => {
  await openAndWrite("Fix the build");
  let answer!: (result: { thread: { id: string } }) => void;
  mac.start.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  await act(async () => fireEvent.click(button("Start")));
  // The worktree and its setup take a while; the person goes back and opens another thread.
  mac.focused = false;
  await act(async () => answer({ thread: { id: "thread-1" } }));
  expect(router.replace).not.toHaveBeenCalled();
});

it("starts a plain folder's thread in the folder, as the desktop does", async () => {
  await openAndWrite("Fix the build");
  await act(async () => fireEvent.click(project("notes")));
  act(() => (nativeProps.get(screen.getByLabelText("Message"))!.onChangeText as (text: string) => void)("Tidy the notes"));
  mac.start.mockResolvedValue({ thread: { id: "thread-2" } });
  await act(async () => fireEvent.click(button("Start")));
  expect(mac.start.mock.calls[0]![0]).toMatchObject({ projectId: "notes", workspaceMode: "current", prompt: "Tidy the notes" });
});

it("starts a worktree in a project that got its first commit after the screen showed it, as the desktop does", async () => {
  await openAndWrite("Fix the build");
  await act(async () => fireEvent.click(project("later")));
  act(() => (nativeProps.get(screen.getByLabelText("Message"))!.onChangeText as (text: string) => void)("Isolate the change"));
  await waitFor(() => expect(button("Start").disabled).toBe(false));
  // The first commit, made on the Mac outside OpenOrc.
  mac.git["later"] = "ready";
  mac.start.mockResolvedValue({ thread: { id: "thread-3" } });
  await act(async () => fireEvent.click(button("Start")));
  expect(mac.start.mock.calls[0]![0]).toMatchObject({ projectId: "later", workspaceMode: "worktree", prompt: "Isolate the change" });
});

it("holds the project while an image is on its way to the Mac", async () => {
  await openAndWrite("Fix the build");
  let upload!: (image: DraftImage) => void;
  vi.mocked(pickImages).mockResolvedValue([{ uri: "file:///a.heic" }] as Awaited<ReturnType<typeof pickImages>>);
  vi.mocked(attachImage).mockReturnValue(new Promise((resolve) => (upload = resolve)));
  await act(async () => fireEvent.click(button("Attach image")));
  expect(project("notes").disabled).toBe(true);
  await act(async () => upload({ path: "/attachments/a.jpg", preview: "file:///cache/a.jpg" }));
  expect(project("notes").disabled).toBe(false);
  expect(screen.getByLabelText("Attached image")).toBeTruthy();
});

it("says why Start is dim when it is tapped, and starts nothing", async () => {
  const models = mac.reads["agents.models"];
  mac.reads["agents.models"] = [];
  onTestFinished(() => void (mac.reads["agents.models"] = models));
  render(<NewThreadScreen />, { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(project("notes")).toBeTruthy());
  act(() => (nativeProps.get(screen.getByLabelText("Message"))!.onChangeText as (text: string) => void)("Fix it"));
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(button("Start"));
  expect((await screen.findByRole("alert")).textContent).toBe("Choose a model");
  expect(mac.start).not.toHaveBeenCalled();
});
