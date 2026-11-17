import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HOSTED_REASONS, type HostedReviewReply, type RpcMethod, type RpcParams, type RpcResults } from "@openorc/protocol";
import { ChangesPanel } from "../panels/ChangesPanel";
import { PanelContent } from "./PanelContent";
import { HostedTurnChangeCard } from "./HostedTurnChangeCard";
import { TurnChangesProvider } from "./TurnFooter";
import { TipLayer } from "./TipLayer";
import { useHostedReviewAction } from "../lib/hosted-review-action";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/client";
import { cloudReviewThread, localReviewThread, pendingAction, recordedChanges, recordedTurn, reviewFile, reviewProject, reviewState } from "./test-fixtures/hosted-review";

vi.mock("./DiffView", () => ({ DiffView: ({ patch }: { patch: string }) => <pre data-testid="saved-diff">{patch}</pre> }));
const reads = new Map<string, unknown>();
let writes: { method: string; params: unknown }[];
let response: HostedReviewReply | Error;
beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  localStorage.clear();
  reads.clear();
  reads.set("account.status", { state: "signed-in", email: "reader@example.com" });
  reads.set("hosted.review.changes", recordedChanges);
  reads.set("hosted.review.state", reviewState);
  reads.set("hosted.review.file", reviewFile);
  reads.set("hosted.review.turn", recordedTurn);
  reads.set("hosted.review.commits", { commits: [], total: 0, pushed: null });
  // This Mac's own read of whether the thread's work can come to a folder here, in place of Push.
  reads.set("macProjects.bringState", { mac: false });
  writes = [];
  response = { accepted: true, action: pendingAction };
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    if (method === "hosted.review.action") {
      writes.push({ method, params });
      if (response instanceof Error) throw response;
      return response as RpcResults[M];
    }
    const value = reads.get(method);
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`Unexpected read: ${method}`);
    return value as RpcResults[M];
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});
const mount = (children = <PanelContent context={{ kind: "thread", thread: cloudReviewThread, project: reviewProject }} page={{ kind: "changes", selection: null }} onNavigate={() => undefined} />) =>
  render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>);
const commits = () => <PanelContent context={{ kind: "thread", thread: cloudReviewThread, project: reviewProject }} page={{ kind: "tool", tool: "commits" }} onNavigate={() => undefined} />;

it("draws saved changes and publishing controls without a local Git or review-comment call", async () => {
  mount();
  expect((await screen.findByTestId("saved-diff")).textContent).toContain("+new");
  expect(screen.getByText("Branch")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Commit" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Push" })).toBeNull();
  expect(screen.queryByRole("button", { name: "PR" })).toBeNull();
  expect(screen.queryByText("Clean workspace")).toBeNull();
  const own = new Set(["account.status", "hosted.capabilities", "macProjects.bringState"]);
  expect(vi.mocked(core.call).mock.calls.every(([method]) => method.startsWith("hosted.review.") || own.has(method))).toBe(true);
});

it.each([
  { state: "missing", turnId: "turn-2", line: "This turn's changes were not saved." },
  { state: "none", line: "No turn has ended yet." },
])("keeps the $state checkpoint state separate from a clean workspace", async (changes) => {
  reads.set("hosted.review.changes", changes);
  mount();
  expect(await screen.findByText(changes.line)).toBeTruthy();
  expect(screen.queryByText("Clean workspace")).toBeNull();
});

it("shows a read failure without using stale change counts", async () => {
  reads.set("hosted.review.changes", new Error("The saved changes could not be read."));
  mount();
  expect(await screen.findByText("The saved changes could not be read.")).toBeTruthy();
  expect(screen.queryByTestId("saved-diff")).toBeNull();
});

it("keeps a later missing checkpoint, omitted files, and cut counts visible", async () => {
  reads.set("hosted.review.changes", { ...recordedChanges, missing: "The latest turn was not recorded.", unlisted: 4 });
  reads.set("hosted.review.file", { ...reviewFile, cut: { shownLines: 4, totalLines: 12000 } });
  mount();
  expect(await screen.findByText("The latest turn was not recorded.")).toBeTruthy();
  expect(await screen.findByText("4 more files are not listed.")).toBeTruthy();
  expect(await screen.findByText("Showing 4 of 12,000 lines.")).toBeTruthy();
});

it("does not call an earlier empty checkpoint clean when the latest checkpoint is missing", async () => {
  reads.set("hosted.review.changes", { ...recordedChanges, files: [], totals: { files: 0, insertions: 0, deletions: 0 }, missing: "The latest turn was not recorded." });
  mount();
  expect(await screen.findByText("The latest turn was not recorded.")).toBeTruthy();
  expect(screen.queryByText("No changes")).toBeNull();
});

it("shows the binary reason instead of an empty patch", async () => {
  reads.set("hosted.review.file", { ...reviewFile, body: { kind: "binary" }, patch: "", note: "This is a binary file." });
  mount();
  expect(await screen.findByText("This is a binary file.")).toBeTruthy();
});

it("keeps PR title and body usable without fetching a template or local branches", async () => {
  reads.set("hosted.review.state", { ...reviewState, work: { uncommitted: null, unpushed: null, published: true } });
  mount(commits());
  await screen.findByRole("button", { name: "PR" });
  await waitFor(() => expect(screen.getByRole("button", { name: "PR" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "PR" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), { target: { value: "Saved example" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Body" }), { target: { value: "Check the example output." } });
  expect(screen.getByRole("textbox", { name: "Base" }).getAttribute("readonly")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open PR" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.params).toMatchObject({ threadId: cloudReviewThread.id, action: { kind: "pull_request", title: "Saved example", body: "Check the example output.", id: expect.any(String) } });
  expect(vi.mocked(core.call).mock.calls.some(([method]) => method === "review.threadPrTemplate" || method.startsWith("git."))).toBe(false);
});

it.each([
  { uncommitted: null, unpushed: { since: "2026-01-01" }, published: false, label: "Publish branch" },
  { uncommitted: null, unpushed: { since: "2026-01-01" }, published: true, label: "Push" },
  { uncommitted: null, unpushed: null, published: true, label: "PR" },
])("puts $label in Commits without inventing an empty history", async ({ label, ...work }) => {
  reads.set("hosted.review.state", { ...reviewState, work });
  mount(commits());
  expect(await screen.findByRole("button", { name: label })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Commit" })).toBeNull();
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  expect(screen.queryByRole("list", { name: "Commits" }), "a thread with no commits lists none").toBeNull();
  expect(vi.mocked(core.call).mock.calls.some(([method]) => method.startsWith("git."))).toBe(false);
});

it("keeps the existing PR beside Refresh and disables Commit when the server reports no dirty work", async () => {
  reads.set("hosted.review.state", { ...reviewState, work: { uncommitted: null, unpushed: null, published: true }, pullRequest: { url: "https://example.com/pull/1", state: "open" } });
  mount();
  expect(await screen.findByRole("button", { name: "open" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Commit" }).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByRole("button", { name: "Push" })).toBeNull();
});

it("draws a saved turn with the same totals and disables Restore with its own reason", async () => {
  mount(
    <>
      <HostedTurnChangeCard threadId={cloudReviewThread.id} turnId="turn-1" />
      <TipLayer />
    </>,
  );
  expect(await screen.findByText("Changed 1 file")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Undo" }).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByText("Restoring a cloud checkpoint isn't available yet.")).toBeNull();
  await act(async () => screen.getByLabelText("Undo this turn's changes").focus());
  expect(await screen.findByText("Restoring a cloud checkpoint isn't available yet.")).toBeTruthy();
});

it.each([
  ["cloud", cloudReviewThread],
  ["Mac", localReviewThread],
])("goes from a turn's saved changes to all of the thread's changes in the same panel (%s)", async (_where, thread) => {
  reads.set("threads.turnChanges", { files: [], patch: "" });
  const onNavigate = vi.fn();
  mount(
    <Suspense>
      <PanelContent
        context={{ kind: "thread", thread, project: reviewProject }}
        page={{ kind: "changes", selection: { kind: "thread", id: thread.id, checkpointId: "turn-1" } }}
        onNavigate={onNavigate}
      />
    </Suspense>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "All changes" }));
  expect(onNavigate).toHaveBeenCalledWith({ kind: "changes", selection: null });
});

it("says why Undo is off when the pointer rests on it", async () => {
  mount(
    <>
      <HostedTurnChangeCard threadId={cloudReviewThread.id} turnId="turn-1" />
      <TipLayer />
    </>,
  );
  expect(await screen.findByText("Changed 1 file")).toBeTruthy();
  const undo = screen.getByRole("button", { name: "Undo" });
  // A browser gives a disabled button no pointer events; this one lets them through to the span that holds the reason.
  expect(undo.className).toContain("disabled:pointer-events-none");
  const trigger = screen.getByLabelText("Undo this turn's changes");
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
  fireEvent.mouseEnter(trigger);
  fireEvent.mouseMove(trigger);
  fireEvent.pointerMove(trigger, { pointerType: "mouse" });
  expect(await screen.findByText("Restoring a cloud checkpoint isn't available yet.", undefined, { timeout: 2000 })).toBeTruthy();
});

it("shows a working turn's reason on a keyboard-reachable review control", async () => {
  reads.set("hosted.review.turn", { state: "working", turnId: "turn-1", line: "This turn's changes aren't recorded yet." });
  mount(<HostedTurnChangeCard threadId={cloudReviewThread.id} turnId="turn-1" />);
  const control = await screen.findByLabelText("Review changes");
  expect(control.getAttribute("tabindex")).toBe("0");
  expect(screen.getByRole("button", { name: "Review changes" }).hasAttribute("disabled")).toBe(true);
  await act(async () => control.focus());
  expect(await screen.findByText("This turn's changes aren't recorded yet.")).toBeTruthy();
});

it("leaves the local empty workspace and RPC path unchanged", async () => {
  reads.set("review.threadDiff", { baseSha: null, files: [], patch: "", since: null });
  mount(<ChangesPanel thread={localReviewThread} project={reviewProject} />);
  expect(await screen.findByText("Clean workspace")).toBeTruthy();
  expect(vi.mocked(core.call).mock.calls.every(([method]) => method === "review.threadDiff")).toBe(true);
});

function ActionProbe({ live = true, account = "reader@example.com" }: { live?: boolean; account?: string }) {
  const action = useHostedReviewAction("cloud-example", live, account);
  return (
    <>
      <button onClick={() => action.start({ kind: "push", id: pendingAction.id })}>Start</button>
      <button onClick={action.retry}>Retry</button>
      <span>{action.pending ? "Pending" : "Settled"}</span>
      <span>{action.error ?? action.refusal ?? action.result?.state}</span>
    </>
  );
}

it("retains the same action across a lost response, unmount and reconnect", async () => {
  response = new Error("OpenOrc Cloud can't be reached.");
  const first = mount(<ActionProbe />);
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByText("OpenOrc Cloud can't be reached.");
  first.unmount();
  const reconnect = mount(<ActionProbe live={false} />);
  expect(screen.getByText("Pending")).toBeTruthy();
  expect(writes).toHaveLength(1);
  response = { accepted: true, action: { ...pendingAction, state: "done", result: { kind: "pushed", branch: "example", sha: "abc1234" } } };
  reconnect.rerender(
    <QueryClientProvider client={queryClient}>
      <ActionProbe />
    </QueryClientProvider>,
  );
  await screen.findByText("done");
  expect(writes).toHaveLength(2);
  expect(writes[0]?.params).toEqual(writes[1]?.params);
});

it("keeps another account from replaying the first account's pending action", async () => {
  const first = mount(<ActionProbe />);
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  first.unmount();
  mount(<ActionProbe account="other@example.com" />);
  await act(async () => undefined);
  expect(screen.getByText("Settled")).toBeTruthy();
  expect(writes).toHaveLength(1);
});

it("reconciles the same pending action on focus after a lost HTTP response", async () => {
  response = new Error("The response was lost.");
  mount(<ActionProbe />);
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByText("The response was lost.");
  response = { accepted: true, action: { ...pendingAction, state: "done", result: { kind: "pushed", branch: "example", sha: "abc1234" } } };
  fireEvent.focus(window);
  await screen.findByText("done");
  expect(writes[0]?.params).toEqual(writes[1]?.params);
});

it.each([
  { accepted: false, refusal: "no_hours", line: "You have no cloud hours left." },
  { accepted: true, action: { ...pendingAction, state: "failed", line: "The remote branch changed.", failure: "moved" } },
] satisfies HostedReviewReply[])("keeps refused and failed actions separate from a successful push", async (reply) => {
  response = reply;
  mount(<ActionProbe />);
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByText("Settled");
  expect(screen.queryByText("done")).toBeNull();
});

it("shows a missing turn route as a disabled control whose reason is on demand", async () => {
  reads.set("hosted.review.turn", new Error(HOSTED_REASONS.changes));
  mount(<HostedTurnChangeCard threadId={cloudReviewThread.id} turnId="turn-1" />);
  const button = await screen.findByRole("button", { name: "Review changes" });
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(screen.queryByText(HOSTED_REASONS.changes)).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  await act(async () => button.parentElement?.focus());
  expect(await screen.findByText(HOSTED_REASONS.changes)).toBeTruthy();
});

it("keeps an older server's open Commits panel unavailable without an error or empty log", async () => {
  reads.set("hosted.review.state", new Error(HOSTED_REASONS.publishing));
  mount(commits());
  const button = await screen.findByRole("button", { name: "Commits unavailable" });
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => button.parentElement?.focus());
  expect(await screen.findByText(HOSTED_REASONS.publishing)).toBeTruthy();
});

it("asks nothing about saved changes once the server says this cloud thread has none, however often the thread refreshes", async () => {
  reads.set("hosted.capabilities", { version: 1, features: { changes: { available: false, reason: HOSTED_REASONS.changes }, publishing: { available: true } } });
  const card = { checkpointId: "turn-1", previousCheckpointId: null, paths: [], hosted: true as const };
  mount(
    <>
      <TurnChangesProvider footers={{ cards: new Map([["block-1", card]]), outside: new Map() }} threadId={cloudReviewThread.id}>
        <HostedTurnChangeCard threadId={cloudReviewThread.id} turnId="turn-1" />
      </TurnChangesProvider>
      <PanelContent context={{ kind: "thread", thread: cloudReviewThread, project: reviewProject }} page={{ kind: "changes", selection: null }} onNavigate={() => undefined} />
    </>,
  );
  expect((await screen.findByRole("button", { name: "Review changes" })).hasAttribute("disabled")).toBe(true);
  expect(await screen.findByText("Changes unavailable")).toBeTruthy();
  for (let i = 0; i < 3; i++) await act(() => queryClient.invalidateQueries());
  const asked = vi.mocked(core.call).mock.calls.map(([method]) => method);
  expect(asked.filter((method) => method === "hosted.review.turn" || method === "hosted.review.changes" || method === "hosted.review.file")).toEqual([]);
  expect(screen.queryByRole("alert")).toBeNull();
});
