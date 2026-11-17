// @vitest-environment jsdom
import type { HostedReviewState, RpcMethod } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { CloudChangesScreen } from "./CloudChangesScreen";

const mac = vi.hoisted(() => ({ phone: null as FakeMac | null, state: null as unknown, actions: [] as unknown[], answer: null as unknown }));
vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method: RpcMethod, params) => {
    if (method === "threads.get") return Promise.resolve({ id: "t1", title: "Fix the export crash", prUrl: null, prState: null, owner: { brain: "hosted", reach: "live", heardAt: 0 } });
    if (method === "hosted.review.changes")
      return Promise.resolve({
        state: "recorded",
        comparison: "base",
        missing: null,
        turnId: "u1",
        baseSha: "a".repeat(40),
        treeSha: "b".repeat(40),
        recordedAt: "2026-11-18T03:00:00.000Z",
        totals: { files: 2, insertions: 12, deletions: 3 },
        files: [
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
