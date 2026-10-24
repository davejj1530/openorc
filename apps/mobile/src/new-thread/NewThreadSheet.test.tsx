// @vitest-environment jsdom
import type { RpcMethod, RpcParams } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { router } from "expo-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { attachImage, pickImages } from "../composer/attachments";
import type { DraftImage } from "../composer/drafts";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { nativeProps } from "../test-fixtures/react-native";
import { NewThreadSheet } from "./NewThreadSheet";

/** A Mac with a repository and a plain folder, and a start the test answers; `focused` is whether the sheet is on top. */
const mac = vi.hoisted(() => {
  const reads: Partial<Record<RpcMethod, unknown>> = {
    "projects.list": [
      { id: "openorc", name: "openorc", defaultBranch: "main" },
      { id: "notes", name: "notes", defaultBranch: null },
    ],
    "agents.models": [{ id: "gpt-main", label: "GPT", agent: "codex", isDefault: true, efforts: ["high"], defaultEffort: "high" }],
    "app.settings.get": { defaultWorkspaceMode: "worktree", defaultPermissionMode: "review" },
  };
  return { reads, focused: true, phone: null as FakeMac | null, start: vi.fn<(params: RpcParams<"threads.start">) => Promise<{ thread: { id: string } }>>() };
});

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method, params) => (method === "threads.start" ? mac.start(params as RpcParams<"threads.start">) : Promise.resolve(mac.reads[method])));
  return mac.phone.module;
});
vi.mock("expo-router", () => ({
  router: { back: vi.fn(), push: vi.fn() },
  useLocalSearchParams: () => ({ projectId: "openorc" }),
  useNavigation: () => ({ isFocused: () => mac.focused }),
}));
vi.mock("expo-status-bar", () => ({ StatusBar: () => null }));
vi.mock("expo-haptics", () => ({ impactAsync: () => Promise.resolve(), selectionAsync: () => Promise.resolve(), ImpactFeedbackStyle: { Light: "light" } }));
vi.mock("../composer/attachments", () => ({ pickImages: vi.fn(), attachImage: vi.fn() }));

beforeEach(() => {
  mac.phone!.saved.clear();
  mac.phone!.module.queryClient.clear();
  mac.start.mockReset();
  mac.focused = true;
  vi.mocked(router.back).mockClear();
  vi.mocked(router.push).mockClear();
});
afterEach(cleanup);

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const project = (name: string) => screen.getByRole("radio", { name }) as HTMLButtonElement;

/** Opens the sheet from the openorc heading's plus and writes the prompt once Start can go. */
async function openAndWrite(prompt: string) {
  render(<NewThreadSheet />, { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(project("notes")).toBeTruthy());
  act(() => (nativeProps.get(screen.getByLabelText("Message"))!.onChangeText as (text: string) => void)(prompt));
  await waitFor(() => expect(button("Start").disabled).toBe(false));
}

it("opens the started thread over Home while the sheet is still showing", async () => {
  await openAndWrite("Fix the build");
  mac.start.mockResolvedValue({ thread: { id: "thread-1" } });
  await act(async () => fireEvent.click(button("Start")));
  await waitFor(() => expect(router.push).toHaveBeenCalledWith({ pathname: "/thread/[id]", params: { id: "thread-1" } }));
  expect(router.back).toHaveBeenCalledTimes(1);
  expect(mac.start.mock.calls[0]![0]).toMatchObject({ projectId: "openorc", workspaceMode: "worktree" });
});

it("leaves the person where they went when the Mac answers after they closed the sheet", async () => {
  await openAndWrite("Fix the build");
  let answer!: (result: { thread: { id: string } }) => void;
  mac.start.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  await act(async () => fireEvent.click(button("Start")));
  // The worktree and its setup take a while; the person swipes the sheet away and opens another thread.
  mac.focused = false;
  await act(async () => answer({ thread: { id: "thread-1" } }));
  expect(router.back).not.toHaveBeenCalled();
  expect(router.push).not.toHaveBeenCalled();
});

it("starts a plain folder's thread in the folder, as the desktop does", async () => {
  await openAndWrite("Fix the build");
  await act(async () => fireEvent.click(project("notes")));
  act(() => (nativeProps.get(screen.getByLabelText("Message"))!.onChangeText as (text: string) => void)("Tidy the notes"));
  mac.start.mockResolvedValue({ thread: { id: "thread-2" } });
  await act(async () => fireEvent.click(button("Start")));
  expect(mac.start.mock.calls[0]![0]).toMatchObject({ projectId: "notes", workspaceMode: "current", prompt: "Tidy the notes" });
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
