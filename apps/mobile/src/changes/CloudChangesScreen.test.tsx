// @vitest-environment jsdom
import type { HostedReviewState, RpcMethod } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { CloudChangesScreen } from "./CloudChangesScreen";

const mac = vi.hoisted(() => ({
  phone: null as FakeMac | null,
  state: null as unknown,
  actions: [] as unknown[],
  answer: null as unknown,
  changes: { available: true } as { available: boolean; reason?: string },
  empty: false,
}));
vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method: RpcMethod, params) => {
    if (method === "threads.get") return Promise.resolve({ id: "t1", title: "Fix the export crash", prUrl: null, prState: null, owner: { brain: "hosted", reach: "live", heardAt: 0 } });
    if (method === "hosted.capabilities") return Promise.resolve({ features: { changes: mac.changes } });
    if (method === "hosted.review.changes")
      return Promise.resolve({
        state: "recorded",
        comparison: "base",
        missing: null,
        turnId: "u1",
        baseSha: "a".repeat(40),
        treeSha: "b".repeat(40),
        recordedAt: "2026-11-18T03:00:00.000Z",
        totals: mac.empty ? { files: 0, insertions: 0, deletions: 0 } : { files: 2, insertions: 12, deletions: 3 },
        files: mac.empty
          ? []
          : [
              { path: "src/export.ts", status: "modified", body: { kind: "text", insertions: 10, deletions: 3 }, withheld: false },
              { path: "src/export.test.ts", status: "added", body: { kind: "text", insertions: 2, deletions: 0 }, withheld: false },
            ],
        unlisted: 0,
      });
    if (method === "hosted.review.state") return Promise.resolve(mac.state);
    if (method === "hosted.review.commits") return Promise.resolve({ commits: [{ sha: "c".repeat(40), subject: "Write pages as they are drawn", author: "Riley", at: 0 }], total: 1, pushed: null });
    if (method === "hosted.review.action") {
      mac.actions.push(params);
      return Promise.resolve(mac.answer);
    }
    return Promise.reject(new Error(`no ${method}`));
  });
  return mac.phone.module;
});
vi.mock("expo-router", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <>{children}</>;
  Stack.Screen = () => null;
  return { router: { push: vi.fn(), back: vi.fn() }, Stack, useLocalSearchParams: () => ({ threadId: "t1" }) };
});

afterEach(() => {
  cleanup();
  mac.phone!.module.client.queryClient.clear();
  mac.actions = [];
  mac.changes = { available: true };
  mac.empty = false;
  mac.phone!.saved.clear();
});

const state = (work: HostedReviewState["work"]): HostedReviewState => ({ branch: "openorc/export", baseBranch: "main", work, actions: [], pullRequest: null });

it("lists the branch's files and commits, and asks OpenOrc Cloud to publish the branch, saying how it went", async () => {
  mac.state = state({ uncommitted: null, unpushed: { since: "2026-11-18T03:00:00.000Z" }, published: false });
  const done = {
    id: "x",
    kind: "push",
    requestedBy: null,
    state: "done",
    result: { kind: "pushed", branch: "openorc/export", sha: "c".repeat(40) },
    refusal: null,
    failure: null,
    line: "Pushed openorc/export.",
    createdAt: "2026-11-18T03:00:00.000Z",
    doneAt: "2026-11-18T03:00:01.000Z",
  };
  mac.answer = { accepted: true, action: done };
  render(<CloudChangesScreen />, { wrapper: mac.phone!.wrapper });
  expect(await screen.findByText("src/export.ts")).toBeTruthy();
  expect(screen.getByText("Write pages as they are drawn")).toBeTruthy();
  // Nothing uncommitted: no Commit, and the branch not on GitHub yet is published.
  expect(screen.queryByRole("button", { name: "Commit" })).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Publish branch" })));
  await waitFor(() => expect(mac.actions).toEqual([{ threadId: "t1", action: { kind: "push", id: expect.any(String) } }]));
  expect(await screen.findByText("Pushed openorc/export.")).toBeTruthy();
});

it("offers Commit while there is work to commit, and nothing to push once the branch is on GitHub", async () => {
  mac.state = state({ uncommitted: { since: "2026-11-18T03:00:00.000Z" }, unpushed: null, published: true });
  render(<CloudChangesScreen />, { wrapper: mac.phone!.wrapper });
  expect(await screen.findByRole("button", { name: "Commit" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Push|Publish/ })).toBeNull();
});

it("counts no files as the desktop does where the server recorded none", async () => {
  mac.empty = true;
  mac.state = state({ uncommitted: null, unpushed: null, published: false });
  render(<CloudChangesScreen />, { wrapper: mac.phone!.wrapper });
  expect(await screen.findByText("0 files")).toBeTruthy();
});

it("says only the server's reason where it does not serve a thread's changes, with nothing to retry", async () => {
  mac.changes = { available: false, reason: "Saved changes aren't available in this cloud thread yet." };
  mac.state = state({ uncommitted: null, unpushed: null, published: true });
  render(<CloudChangesScreen />, { wrapper: mac.phone!.wrapper });
  expect(await screen.findByText("Saved changes aren't available in this cloud thread yet.")).toBeTruthy();
  expect(screen.queryByText("Retry")).toBeNull();
  expect(screen.queryByText("src/export.ts")).toBeNull();
});

it("keeps a running push's pill, reading that it runs, though the server's state is already past it", async () => {
  // The server already says the branch is on GitHub; the push asked from the phone still answers that it runs.
  mac.state = state({ uncommitted: null, unpushed: null, published: true });
  const running = { id: "x", kind: "push", requestedBy: null, state: "running", result: null, refusal: null, failure: null, line: null, createdAt: "2026-11-18T03:00:00.000Z", doneAt: null };
  mac.answer = { accepted: true, action: running };
  render(<CloudChangesScreen />, { wrapper: mac.phone!.wrapper });
  await screen.findByText("src/export.ts");
  const { startCloudReview } = await import("../cloud/cloud-review");
  act(() => startCloudReview("t1", { kind: "push", id: "00000000-0000-4000-8000-000000000001" }));
  expect(await screen.findByRole("button", { name: "Pushing…" })).toBeTruthy();
});
