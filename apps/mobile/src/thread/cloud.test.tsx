// @vitest-environment jsdom
import type { CloudThreadState, FileChange, RpcMethod, ThreadSummary } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fixtureThreads } from "../home/test-fixtures/threads";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { CloudMoveSheet } from "./CloudMoveSheet";
import { MessageQueue } from "../composer/MessageQueue";
import { CloudPreparing, CloudStart } from "./CloudStart";
import { statusLine } from "./ThreadHeader";

const mac = vi.hoisted(() => ({
  phone: null as FakeMac | null,
  reads: {} as Partial<Record<RpcMethod, (params: unknown) => Promise<unknown>>>,
}));

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method, params) => mac.reads[method]?.(params) ?? Promise.reject(new Error(`no ${method}`)));
  return mac.phone.module;
});
vi.mock("react-native-keyboard-controller", () => ({ useKeyboardState: <T,>(select: (state: { isVisible: boolean }) => T) => select({ isVisible: false }) }));
vi.mock("expo-router", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <>{children}</>;
  Stack.Screen = () => null;
  return { router: { push: vi.fn(), back: vi.fn() }, Stack, useLocalSearchParams: () => ({ threadId: "t1" }) };
});

const base = { ...fixtureThreads[0]!, id: "t1", projectId: "p1", title: "Add a footer", agent: "claude" } satisfies ThreadSummary;
const cloud = (more: Partial<CloudThreadState> = {}): CloudThreadState => ({ provider: "vercel", state: "preparing", step: "code", setup: true, error: null, ...more });
const queued = { id: "m1", text: "Add a footer with the links", attachments: [], queuedAt: 1 };
const starting = (state: CloudThreadState, message: Partial<typeof queued> & { interrupted?: boolean; error?: string } = {}) =>
  ({ ...base, cloud: state, queued: [{ ...queued, ...message }] }) as ThreadSummary & { cloud: CloudThreadState };

beforeEach(() => {
  mac.phone!.module.queryClient.clear();
  vi.mocked(router.back).mockClear();
  mac.reads = {};
});
afterEach(cleanup);

it("shows a starting cloud thread's setup as steps over the message that waits for it", () => {
  render(<CloudStart thread={starting(cloud())} />, { wrapper: mac.phone!.wrapper });
  expect(screen.getByText("Setting up the cloud workspace")).toBeTruthy();
  for (const label of ["Starting a Vercel sandbox", "Sending your code", "Running the setup script", "Starting Claude"]) expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByText("Add a footer with the links")).toBeTruthy();
});

it("shows a thread on the cloud brain with the brain's wake done before its own setup", () => {
  const onBrain = { ...starting(cloud({ provider: "agent37", step: "sandbox", setup: false })), owner: { brain: "cloud", reach: "live", heardAt: 1 } } as const;
  render(<CloudStart thread={onBrain} />, { wrapper: mac.phone!.wrapper });
  for (const label of ["Waking the cloud brain", "Starting an Agent37 instance", "Sending your code", "Starting Claude"]) expect(screen.getByText(label)).toBeTruthy();
});

it("says why the setup failed, and Try again sends the waiting message again", async () => {
  const sendQueued = vi.fn(async () => base);
  mac.reads["threads.sendQueued"] = sendQueued;
  render(<CloudStart thread={starting(cloud({ state: "failed", error: "Vercel refused the sandbox: the team is over its limit." }))} />, { wrapper: mac.phone!.wrapper });
  expect(screen.getByText("The cloud workspace did not start")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe("Vercel refused the sandbox: the team is over its limit.");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(sendQueued).toHaveBeenCalledWith({ id: "t1", messageId: "m1" }));
});

it("says what failed in a line with Try again beside it, and the sandbox's log only when asked for", () => {
  const error = "Docker did not start in the sandbox.\ntime=1 level=info msg=starting\nfailed to start daemon: iptables: Protocol not supported";
  render(<CloudStart thread={starting(cloud({ provider: "agent37", state: "failed", error }), { interrupted: true, error })} />, { wrapper: mac.phone!.wrapper });
  expect(screen.getByRole("alert").textContent).toBe("Docker did not start in the sandbox.");
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(screen.queryByText(/iptables/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText(/failed to start daemon: iptables/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
  expect(screen.queryByText(/iptables/)).toBeNull();
});

it("shows a retried setup's steps rather than the failure before it, while its message still waits marked as not sent", () => {
  const error = "Docker did not start in the sandbox.\nfailed to start daemon";
  render(<CloudStart thread={starting(cloud({ provider: "agent37", state: "preparing", step: "sandbox", setup: false }), { interrupted: true, error })} />, { wrapper: mac.phone!.wrapper });
  expect(screen.getByText("Setting up the cloud workspace")).toBeTruthy();
  expect(screen.getByText("Starting an Agent37 instance")).toBeTruthy();
  expect(screen.queryByText("The cloud workspace did not start")).toBeNull();
});

it("shows the step a sandbox set up again is on, in one line above the composer", () => {
  render(<CloudPreparing thread={starting(cloud({ provider: "agent37", state: "preparing", step: "code", setup: false }))} />, { wrapper: mac.phone!.wrapper });
  expect(screen.getByText("Sending your code")).toBeTruthy();
  expect(screen.getByText("2 of 3")).toBeTruthy();
});

it("says a queued message that failed did not send, in its first line, with Retry and Remove in reach", () => {
  const error = "Docker did not start in the sandbox.\n" + "time=1 level=info msg=line\n".repeat(40);
  const failed = { ...queued, interrupted: true, error };
  const onSend = vi.fn();
  render(<MessageQueue messages={[failed]} canSend pending={false} agentName="Claude" typing={false} onSend={onSend} onRemove={() => undefined} />, { wrapper: mac.phone!.wrapper });
  expect(screen.getByText("Didn't send")).toBeTruthy();
  expect(screen.queryByText(/Sends when/)).toBeNull();
  expect(screen.getByText("Docker did not start in the sandbox.")).toBeTruthy();
  expect(screen.queryByText(/level=info/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(onSend).toHaveBeenCalledWith("m1");
});

it("names where a cloud thread runs in the header's line", () => {
  expect(statusLine({ ...base, cloud: cloud({ state: "ready" }) }, "Site")).toMatch(/^Site · Vercel Sandbox/);
  expect(statusLine({ ...base, cloud: cloud({ provider: "local", state: "ready" }) }, "Site")).toMatch(/^Site · Simulated sandbox/);
  expect(statusLine({ ...base, cloud: cloud({ state: "removed" }) }, "Site")).toMatch(/^Site · Sandbox removed/);
});

function moveSheet(mode: "current" | "worktree", move: () => Promise<unknown> = async () => base) {
  const files: FileChange[] = Array.from({ length: 8 }, (_, index) => ({ path: `src/file-${index}.tsx`, status: "modified", oldPath: null }));
  const preview = vi.fn(async () => ({ files, blocked: null }));
  const moved = vi.fn(move);
  mac.reads["threads.get"] = async () => ({ ...base, workspaceMode: mode });
  mac.reads["threads.movePreview"] = preview;
  mac.reads["cloud.move"] = moved;
  render(<CloudMoveSheet />, { wrapper: mac.phone!.wrapper });
  return { preview, moved };
}

it("moves a worktree conversation to the cloud and closes", async () => {
  const { preview, moved } = moveSheet("worktree");
  await screen.findByText("Add a footer");
  expect(screen.getByText(/Its worktree, uncommitted changes and session go to a sandbox of its own/)).toBeTruthy();
  expect(preview).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Move" })));
  expect(moved).toHaveBeenCalledWith({ threadId: "t1" });
  await waitFor(() => expect(router.back).toHaveBeenCalled());
});

it("lists the files a checkout conversation takes with it, and keeps a refusal in the sheet", async () => {
  moveSheet("current", async () => {
    throw new Error("“Work” has no token for cloud threads. Create one in Settings → Cloud.");
  });
  await screen.findByText("src/file-0.tsx");
  expect(screen.getByText(/Every uncommitted change in the checkout first moves into a new worktree/)).toBeTruthy();
  expect(screen.queryByText("src/file-6.tsx")).toBeNull();
  expect(screen.getByText("and 2 more")).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Move" })));
  expect((await screen.findByRole("alert")).textContent).toBe("“Work” has no token for cloud threads. Create one in Settings → Cloud.");
  expect(router.back).not.toHaveBeenCalled();
});
