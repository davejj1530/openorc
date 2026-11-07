import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CloudThreadState, ThreadSummary } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { preparingCloud } from "@openorc/client";
import { CloudPreparing, CloudStart, queueAfterStart } from "./CloudStart";
import { core } from "../lib/rpc";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const first = { id: "first", text: "Add a footer", attachments: [], queuedAt: 1 };
const preparing: CloudThreadState = { provider: "vercel", state: "preparing", step: "code", setup: true, error: null };

function cloudThread(cloud: CloudThreadState | null, queued: ThreadSummary["queued"] = [first]): ThreadSummary {
  return {
    id: "thread",
    projectId: "project",
    title: "Footer",
    agent: "claude",
    model: null,
    effort: null,
    fastMode: false,
    mode: "act",
    permissionMode: "review",
    workspaceMode: "worktree",
    branch: "openorc/footer",
    worktreePath: "/tmp/footer",
    baseSha: null,
    baseBranch: "main",
    pinnedAt: null,
    seenAt: null,
    doneAt: null,
    snoozedUntil: null,
    prUrl: null,
    prState: null,
    forkedFromId: null,
    forkedAtRunId: null,
    draft: "",
    importedFrom: null,
    createdAt: 0,
    updatedAt: 0,
    lastActivityAt: 0,
    archivedAt: null,
    activity: "idle",
    unread: false,
    session: { status: "idle", message: null },
    context: null,
    queued,
    lastAgentEventAt: null,
    taskCount: 0,
    openTaskCount: 0,
    cloud,
  };
}

function show(thread: ThreadSummary, runs = 0) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CloudStart thread={thread} runs={runs} fallback={<p>No messages yet</p>} />
    </QueryClientProvider>,
  );
}

it("shows the sandbox's setup as steps above the first message while it is prepared", () => {
  show(cloudThread(preparing));
  const steps = within(screen.getByRole("list"))
    .getAllByRole("listitem")
    .map((row) => [row.textContent, row.dataset.state]);
  expect(steps).toEqual([
    ["Starting a Vercel sandbox", "done"],
    ["Sending your code", "running"],
    ["Running the setup script", "pending"],
    ["Starting Claude", "pending"],
  ]);
  expect(screen.getByText("Add a footer")).toBeTruthy();
});

it("starts a thread on the cloud brain by waking it, then shows the brain's own setup, and a wake that failed like any", async () => {
  const onBrain = (cloud: CloudThreadState): ThreadSummary => ({ ...cloudThread(cloud), worktreePath: null, owner: { brain: "cloud", reach: "waking", heardAt: 1 } });
  const labels = () =>
    within(screen.getByRole("list"))
      .getAllByRole("listitem")
      .map((row) => [row.textContent, row.dataset.state]);
  show(onBrain({ provider: "agent37", state: "preparing", step: null, setup: false, error: null, brain: "updating" }));
  expect(labels()).toEqual([
    ["Updating the cloud brain", "running"],
    ["Starting an Agent37 instance", "pending"],
    ["Sending your code", "pending"],
    ["Starting Claude", "pending"],
  ]);
  cleanup();
  vi.mocked(core.call).mockResolvedValue([first]);
  show(onBrain({ provider: "agent37", state: "failed", step: null, setup: false, error: "The cloud brain did not start. Agent37 is down." }));
  expect(screen.getByRole("alert").textContent).toBe("The cloud brain did not start. Agent37 is down.");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("threads.sendQueued", { id: "thread", messageId: "first" }));
});

it("offers to try again with the waiting message when the sandbox failed", async () => {
  vi.mocked(core.call).mockResolvedValue(null);
  show(cloudThread({ ...preparing, state: "failed", step: null, error: "Vercel refused the sandbox: quota reached" }));
  expect(screen.getByRole("alert").textContent).toBe("Vercel refused the sandbox: quota reached");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("threads.sendQueued", { id: "thread", messageId: "first" }));
});

it("says what failed in a line and keeps the sandbox's log under Details, and shows a retry's steps, not the old failure", () => {
  const error = "Docker did not start in the sandbox.\nfailed to start daemon: iptables: Protocol not supported";
  const failedFirst = { ...first, interrupted: true, error };
  show(cloudThread({ ...preparing, provider: "agent37", state: "failed", step: null, setup: false, error }, [failedFirst]));
  expect(screen.getByRole("alert").textContent).toBe("Docker did not start in the sandbox.");
  expect(screen.getByText("Details").closest("details")?.open).toBe(false);
  expect(screen.getByText(/iptables: Protocol not supported/)).toBeTruthy();
  cleanup();
  show(cloudThread({ ...preparing, provider: "agent37", state: "preparing", step: "sandbox", setup: false }, [failedFirst]));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Starting an Agent37 instance")).toBeTruthy();
});

it("shows the step a sandbox set up again is on above the composer, once the thread has run, and nothing otherwise", () => {
  const again = cloudThread({ ...preparing, provider: "agent37", step: "code", setup: false }, []);
  render(<CloudPreparing thread={preparingCloud(again, 2)} />);
  expect(screen.getByRole("status").textContent).toBe("Sending your code2 of 3");
  cleanup();
  render(<CloudPreparing thread={preparingCloud(again, 0)} />);
  expect(screen.queryByRole("status")).toBeNull();
});

it("leaves threads that are not starting in the cloud to the ordinary conversation", () => {
  show(cloudThread(null));
  expect(screen.getByText("No messages yet")).toBeTruthy();
  cleanup();
  show(cloudThread({ ...preparing, state: "ready", step: null }), 1);
  expect(screen.getByText("No messages yet")).toBeTruthy();
});

it("keeps the first message out of the queue only while it waits in the setup card", () => {
  const second = { id: "second", text: "And a header", attachments: [], queuedAt: 2 };
  expect(queueAfterStart(cloudThread(preparing, [first, second]), 0)).toEqual([second]);
  expect(queueAfterStart(cloudThread(preparing, [first, second]), 1)).toEqual([first, second]);
  expect(queueAfterStart(cloudThread(null, [first]), 0)).toEqual([first]);
});
