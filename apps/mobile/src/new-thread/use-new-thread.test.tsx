// @vitest-environment jsdom
import { harnessIds, WORKSPACE_ID, type HarnessId, type ModelOption, type ProjectGit, type RpcMethod, type RpcParams } from "@openorc/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { attachImage, pickImages } from "../composer/attachments";
import type { DraftImage } from "../composer/drafts";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { useNewThread } from "./use-new-thread";

/**
 * The Mac as the sheet hears it: a catalog, which harnesses are signed in, its settings, each project's git (a promise
 * while the Mac is still reading it), and a start that a test answers.
 */
const mac = vi.hoisted(() => {
  const models: ModelOption[] = [
    { id: "gpt-mini", label: "GPT mini", agent: "codex", isDefault: false, efforts: ["low", "medium"], defaultEffort: "low" },
    { id: "gpt-main", label: "GPT", agent: "codex", isDefault: true, efforts: ["medium", "high"], defaultEffort: "high" },
    { id: "opus", label: "Opus", agent: "claude", isDefault: true, efforts: ["high", "max"], defaultEffort: "high" },
  ];
  const reads: Partial<Record<RpcMethod, unknown>> = {};
  const git: Record<string, ProjectGit | Promise<ProjectGit>> = {};
  return { models, reads, git, phone: null as FakeMac | null, start: vi.fn<(params: RpcParams<"threads.start">) => Promise<{ thread: { id: string } }>>() };
});

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method, params) => {
    if (method === "threads.start") return mac.start(params as RpcParams<"threads.start">);
    if (method === "projects.git") return Promise.resolve(mac.git[(params as RpcParams<"projects.git">).id] ?? "ready");
    return Promise.resolve(mac.reads[method]);
  });
  return mac.phone.module;
});
vi.mock("../composer/attachments", () => ({ pickImages: vi.fn(), attachImage: vi.fn() }));
vi.mock("expo-haptics", () => ({ impactAsync: () => Promise.resolve(), ImpactFeedbackStyle: { Light: "light" } }));

/** What the Mac answers about its harnesses and settings: Codex and Claude signed in, no default harness yet. */
function macState({ signedIn = ["codex", "claude"], defaultHarness = null }: { signedIn?: HarnessId[]; defaultHarness?: HarnessId | null } = {}) {
  mac.reads["agents.models"] = mac.models;
  mac.reads["agents.availability"] = harnessIds.map((id) => ({ id, state: signedIn.includes(id) ? "ready" : "sign_in" }));
  mac.reads["app.settings.get"] = { defaultWorkspaceMode: "worktree", defaultPermissionMode: "review", defaultHarness };
}

beforeEach(() => {
  mac.phone!.saved.clear();
  mac.phone!.module.queryClient.clear();
  mac.start.mockReset();
  for (const id of Object.keys(mac.git)) delete mac.git[id];
  macState();
});
afterEach(cleanup);

const image = { path: "/Users/me/Library/Application Support/OpenOrc/attachments/0b1c.jpg", preview: "file:///cache/0b1c.jpg" };
const sent = () => mac.start.mock.calls.at(-1)![0];

/** The sheet in a project. */
function open(projectId: string) {
  return renderHook(() => useNewThread(projectId), { wrapper: mac.phone!.wrapper });
}
type Sheet = ReturnType<typeof open>;

/** Writes the prompt and waits for the Mac's catalog and settings, so Start can go. */
async function write(sheet: Sheet, prompt: string) {
  act(() => sheet.result.current.setText(prompt));
  await waitFor(() => expect(sheet.result.current.controls.canSend).toBe(true));
}
const submit = async (sheet: Sheet) => {
  let started: string | null = null;
  await act(async () => void (started = await sheet.result.current.submit()));
  return started;
};

it("starts with the desktop's defaults and never names a folder", async () => {
  const sheet = open("openorc");
  await write(sheet, " Fix the build ");
  expect(sheet.result.current.settings.choice).toEqual({ agent: "codex", model: "gpt-main", effort: "high" });
  mac.start.mockResolvedValue({ thread: { id: "thread-1" } });
  expect(await submit(sheet)).toBe("thread-1");
  expect(sent()).toEqual({
    projectId: "openorc",
    agent: "codex",
    model: "gpt-main",
    effort: "high",
    fastMode: false,
    mode: "act",
    permissionMode: "review",
    workspaceMode: "worktree",
    prompt: "Fix the build",
    attachments: [],
  });

  const workspace = open(WORKSPACE_ID);
  await write(workspace, "Plan the week");
  await submit(workspace);
  expect(sent()).toMatchObject({ projectId: WORKSPACE_ID, workspaceMode: "current" });
  expect(sent()).not.toHaveProperty("workingDirectory");
});

it.each([
  { name: "the first signed-in harness without a default", signedIn: ["codex", "claude"], defaultHarness: null, expected: { agent: "codex", model: "gpt-main", effort: "high" } },
  { name: "Claude, chosen as the default at onboarding", signedIn: ["codex", "claude"], defaultHarness: "claude", expected: { agent: "claude", model: "opus", effort: "high" } },
  { name: "Claude, the only harness signed in", signedIn: ["claude"], defaultHarness: null, expected: { agent: "claude", model: "opus", effort: "high" } },
  { name: "Claude, when the default is signed out", signedIn: ["claude"], defaultHarness: "codex", expected: { agent: "claude", model: "opus", effort: "high" } },
] satisfies { name: string; signedIn: HarnessId[]; defaultHarness: HarnessId | null; expected: object }[])(
  "offers the model the desktop would: $name",
  async ({ signedIn, defaultHarness, expected }) => {
    macState({ signedIn, defaultHarness });
    const sheet = open("openorc");
    await write(sheet, "Fix the build");
    expect(sheet.result.current.settings.choice).toEqual(expected);
    mac.start.mockResolvedValue({ thread: { id: "thread-1" } });
    await submit(sheet);
    expect(sent()).toMatchObject(expected);
  },
);

it.each([
  ["a folder without git", "none"],
  ["a repository before its first commit", "no_commits"],
] as const)("works in %s itself, as the desktop's New thread does whatever the Mac's default", async (_case, state) => {
  mac.git["notes"] = state;
  const plain = open("notes");
  await write(plain, "Tidy the notes folder");
  mac.start.mockResolvedValue({ thread: { id: "thread-1" } });
  await submit(plain);
  expect(sent()).toMatchObject({ projectId: "notes", workspaceMode: "current" });
});

it("asks the Mac's git when Start is tapped, holding the start meanwhile, then branches where it can", async () => {
  let read!: (state: ProjectGit) => void;
  mac.git["openorc"] = new Promise((resolve) => (read = resolve));
  const sheet = open("openorc");
  await write(sheet, "Fix the build");
  mac.start.mockResolvedValue({ thread: { id: "thread-1" } });
  let started!: Promise<string | null>;
  act(() => void (started = sheet.result.current.submit()));
  expect(sheet.result.current.starting).toBe(true);
  expect(sheet.result.current.controls.canSend).toBe(false);
  expect(mac.start).not.toHaveBeenCalled();
  await act(async () => {
    read("ready");
    await started;
  });
  expect(sent()).toMatchObject({ projectId: "openorc", workspaceMode: "worktree" });
  expect(sheet.result.current.starting).toBe(false);
});

it("branches in a project that got its first commit on the Mac after the sheet opened, and not once its git is gone", async () => {
  mac.git["later"] = "none";
  const sheet = open("later");
  await write(sheet, "Isolate the change");
  mac.git["later"] = "ready";
  mac.start.mockResolvedValue({ thread: { id: "thread-1" } });
  await submit(sheet);
  expect(sent()).toMatchObject({ projectId: "later", workspaceMode: "worktree" });

  mac.git["later"] = "none";
  await write(sheet, "Try again in the folder");
  await submit(sheet);
  expect(sent()).toMatchObject({ projectId: "later", workspaceMode: "current" });
});

it("sends nothing when the Mac cannot say whether the project can branch, keeps the draft and says why", async () => {
  const unreadable = Promise.reject(new Error("git rev-parse failed"));
  unreadable.catch(() => undefined);
  mac.git["openorc"] = unreadable;
  const sheet = open("openorc");
  await write(sheet, "Fix the build");
  expect(await submit(sheet)).toBeNull();
  expect(mac.start).not.toHaveBeenCalled();
  expect(sheet.result.current.error).toBe("git rev-parse failed");
  expect(sheet.result.current.draft.prompt).toBe("Fix the build");

  // Start stays on, so the next tap asks again.
  mac.git["openorc"] = "ready";
  mac.start.mockResolvedValue({ thread: { id: "thread-1" } });
  expect(await submit(sheet)).toBe("thread-1");
  expect(sent()).toMatchObject({ projectId: "openorc", workspaceMode: "worktree" });
});

it("keeps the draft, its mode and permission through a start the Mac refuses, and says why", async () => {
  const sheet = open("plain-folder");
  await write(sheet, "Tidy the docs");
  act(() => {
    sheet.result.current.settings.selectModel({ agent: "codex", model: "gpt-mini", effort: "medium" });
    sheet.result.current.settings.selectExecutionMode({ mode: "act", permissionMode: "autonomous" });
  });
  mac.start.mockRejectedValue(new Error("plain-folder isn't a git repository yet. Worktrees and teams need git and a first commit."));
  expect(await submit(sheet)).toBeNull();
  expect(sent()).toMatchObject({ permissionMode: "autonomous" });
  expect(sheet.result.current.error).toBe("plain-folder isn't a git repository yet. Worktrees and teams need git and a first commit.");

  // Closing the sheet and coming back finds the same draft, and Start would send the same permission.
  sheet.unmount();
  const again = open("plain-folder");
  expect(again.result.current.draft).toMatchObject({ prompt: "Tidy the docs", mode: "act", target: { kind: "model", choice: { model: "gpt-mini", effort: "medium" } } });
  expect(again.result.current.settings.permission).toBe("autonomous");
  expect(again.result.current.error).toBeNull();

  // The phone keeps the choice for new threads as the desktop keeps its default: other projects start with it too.
  const other = open("openorc");
  await write(other, "Fix the build");
  mac.start.mockResolvedValue({ thread: { id: "thread-2" } });
  await submit(other);
  expect(sent()).toMatchObject({ projectId: "openorc", permissionMode: "autonomous" });
});

it("starts one thread however quickly Start is tapped again", async () => {
  const sheet = open("openorc");
  await write(sheet, "Fix the build");
  mac.start.mockResolvedValue({ thread: { id: "thread-1" } });
  let started: (string | null)[] = [];
  await act(async () => void (started = await Promise.all([sheet.result.current.submit(), sheet.result.current.submit()])));
  expect(mac.start).toHaveBeenCalledTimes(1);
  expect(started).toEqual(["thread-1", null]);
});

it("clears what a started thread took and keeps the project's model and mode", async () => {
  mac.phone!.saved.set(
    "newthread.mac-1.openorc",
    JSON.stringify({ prompt: "", mode: "plan", target: { kind: "model", choice: { agent: "codex", model: "gpt-mini", effort: "low" } }, images: [image] }),
  );
  const sheet = open("openorc");
  await waitFor(() => expect(sheet.result.current.controls.canSend).toBe(true));
  mac.start.mockResolvedValue({ thread: { id: "thread-2" } });
  await submit(sheet);
  expect(sent()).toMatchObject({ prompt: "See the attached image.", attachments: [image.path], mode: "plan", model: "gpt-mini" });
  expect(sheet.result.current.draft).toMatchObject({ prompt: "", images: [], mode: "plan", target: { kind: "model", choice: { model: "gpt-mini" } } });
  expect(JSON.parse(mac.phone!.saved.get("newthread.mac-1.openorc")!)).toMatchObject({ prompt: "", images: [], mode: "plan" });
});

it("clears what a start took even when the Mac answers after the sheet has closed", async () => {
  const sheet = open("openorc");
  await write(sheet, "Fix the build");
  let answer!: (result: { thread: { id: string } }) => void;
  mac.start.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  let started!: Promise<string | null>;
  act(() => void (started = sheet.result.current.submit()));
  await waitFor(() => expect(mac.start).toHaveBeenCalled());
  sheet.unmount();
  await act(async () => {
    answer({ thread: { id: "thread-3" } });
    await started;
  });
  expect(JSON.parse(mac.phone!.saved.get("newthread.mac-1.openorc")!)).toMatchObject({ prompt: "" });
});

it("keeps the images that land after the sheet has closed", async () => {
  const sheet = open("openorc");
  const uploads: ((image: DraftImage) => void)[] = [];
  vi.mocked(pickImages).mockResolvedValue([{ uri: "file:///a.heic" }, { uri: "file:///b.heic" }] as Awaited<ReturnType<typeof pickImages>>);
  vi.mocked(attachImage).mockImplementation(() => new Promise((resolve) => uploads.push(resolve)));
  act(() => sheet.result.current.chooseImages());
  await waitFor(() => expect(uploads).toHaveLength(2));
  sheet.unmount();
  const second = { path: "/attachments/b.jpg", preview: "file:///cache/b.jpg" };
  await act(async () => {
    uploads[0]!(image);
    uploads[1]!(second);
  });
  expect(JSON.parse(mac.phone!.saved.get("newthread.mac-1.openorc")!)).toMatchObject({ images: [image, second] });
});
