import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderPath, type HostedActionRequest, type HostedReviewAction } from "@openorc/protocol";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const email = "reader@example.com";
const at = "2026-01-01T00:00:00.000Z";
const file = { path: "src/example.ts", oldPath: null, status: "modified", body: { kind: "text", insertions: 3, deletions: 1 }, withheld: false };
const recorded = {
  state: "recorded",
  comparison: "base",
  turnId: "turn-1",
  baseSha: "abc",
  treeSha: "def",
  recordedAt: at,
  totals: { files: 1, insertions: 3, deletions: 1 },
  files: [file],
  unlisted: 0,
  missing: null,
};
let stand: StandIn;
let hosted: Hosted;
let threadId: string;
let answer: unknown;
let status: number;
let beforeReply: (() => Promise<void>) | null;
let requests: { path: string; body: unknown; space: string | null }[];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  threadId = stand.addThread(email, { projectId: null, title: "Saved changes" });
  answer = recorded;
  status = 200;
  beforeReply = null;
  requests = [];
  const { deps, browser } = hostDeps(stand, newDevice(), {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/changes") || /\/(commit|push|pull-request)$/.test(url.pathname)) {
        requests.push({ path: url.pathname + url.search, body: typeof init?.body === "string" ? JSON.parse(init.body) : null, space: new Headers(init?.headers).get("x-openorc-space") });
        await beforeReply?.();
        if (answer instanceof Error) throw answer;
        return Response.json(answer, { status });
      }
      return fetch(input, init);
    },
  });
  hosted = createHosted(deps);
  await hosted.start();
  await signInAs(hosted, browser, email);
  await vi.waitFor(() => expect(hosted.threads.holds({ thread: threadId })).toBe(true));
});

const id = "d9674701-b0c8-42f2-9efe-a416090d1ca1";
const requestsForActions: HostedActionRequest[] = [
  { kind: "commit", id, message: "Update example" },
  { kind: "push", id },
  { kind: "pull_request", id, title: "Update example", body: "Adjust the saved example." },
];
function actionRow(request: HostedActionRequest, state: HostedReviewAction["state"]): HostedReviewAction {
  let result: HostedReviewAction["result"] = { kind: "committed", sha: "abc1234" };
  if (request.kind === "push") result = { kind: "pushed", branch: "example", sha: "abc1234" };
  if (request.kind === "pull_request") result = { kind: "pull_request", number: 1, url: "https://example.com/pull/1", by: "person", pushed: "abc1234" };
  return {
    id,
    kind: request.kind,
    state,
    requestedBy: "reader",
    createdAt: at,
    doneAt: state === "waiting" || state === "running" ? null : at,
    result: state === "done" ? result : null,
    refusal: state === "refused" ? "no_hours" : null,
    failure: state === "failed" ? "moved" : null,
    line: state === "failed" ? "The remote branch changed. Pull its changes before pushing." : null,
  };
}

describe.each(requestsForActions)("cloud $kind actions", (request) => {
  it.each(["waiting", "running", "done", "refused", "failed"] as const)("retains the %s state without claiming accepted means complete", async (state) => {
    const action = actionRow(request, state);
    answer = { accepted: true, action };
    expect(await hosted.threads.call("hosted.review.action", { threadId, action: request })).toEqual(answer);
    const { kind, ...body } = request;
    expect(requests[0]).toMatchObject({ path: `/hosted/threads/${threadId}/${kind === "pull_request" ? "pull-request" : kind}`, body });
  });

  it("reuses the exact id and input after a lost response", async () => {
    answer = new Error("lost response");
    await expect(hosted.threads.call("hosted.review.action", { threadId, action: request })).rejects.toThrow("OpenOrc Cloud can't be reached.");
    answer = { accepted: true, action: actionRow(request, "done") };
    await hosted.threads.call("hosted.review.action", { threadId, action: request });
    expect(requests[0]?.body).toEqual(requests[1]?.body);
    expect(requests).toHaveLength(2);
  });
});

it("returns a readable immediate refusal without fabricating an action row", async () => {
  answer = { accepted: false, refusal: "no_hours" };
  expect(await hosted.threads.call("hosted.review.action", { threadId, action: requestsForActions[1]! })).toMatchObject({ accepted: false, refusal: "no_hours", line: expect.any(String) });
});

it("keeps the recorded diff and later missing-checkpoint caveat together", async () => {
  answer = { ...recorded, missing: "The latest turn's changes were not saved.", unlisted: 7 };
  expect(await hosted.threads.call("hosted.review.changes", { threadId })).toEqual(answer);
});

it("reads changes a terminal's work left after the last turn, which belong to no turn", async () => {
  answer = { ...recorded, turnId: null };
  expect(await hosted.threads.call("hosted.review.changes", { threadId })).toEqual(answer);
  expect(await hosted.threads.call("review.threadChanges", { threadId, comparison: "base" })).toMatchObject({ baseSha: "abc", files: [file] });
});

it("does not return protected changes after the session changes during a read", async () => {
  beforeReply = () => hosted.account.signOut();
  await expect(hosted.threads.call("hosted.review.changes", { threadId })).rejects.toThrow("You no longer have access to this project.");
});
afterEach(async () => {
  hosted.close();
  await stand.close();
});

describe("cloud review bridges", () => {
  it("does not relabel the branch's saved file diff as uncommitted work", async () => {
    answer = { path: file.path, oldPath: null, status: file.status, body: file.body, patch: "@@ -1 +1 @@\n-old\n+new\n", cut: null, note: null };
    await expect(hosted.threads.call("review.threadFileDiff", { threadId, path: FolderPath.parse(file.path), comparison: "head" })).rejects.toThrow(
      "Uncommitted changes aren't available separately in this cloud thread yet.",
    );
    expect(requests).toEqual([]);
  });

  it("reads the server's cumulative changes in the thread's captured space", async () => {
    expect(await hosted.threads.call("review.threadChanges", { threadId, comparison: "base" })).toMatchObject({ comparison: "base", baseSha: "abc", totals: recorded.totals, files: [file] });
    expect(requests).toMatchObject([{ path: `/hosted/threads/${threadId}/changes`, space: expect.any(String) }]);
  });

  it("does not turn a server failure into a clean workspace", async () => {
    answer = { message: "The saved changes could not be read." };
    status = 503;
    await expect(hosted.threads.call("review.threadDiff", { threadId, comparison: "base" })).rejects.toThrow("The saved changes could not be read.");
  });

  it("keeps a missing checkpoint's reason", async () => {
    answer = { state: "missing", turnId: "turn-2", line: "This turn's changes were not saved." };
    await expect(hosted.threads.call("review.threadChanges", { threadId })).rejects.toThrow("This turn's changes were not saved.");
  });

  it("keeps a working turn's reason", async () => {
    answer = { state: "working", turnId: "turn-2", line: "This turn's changes are not recorded yet." };
    await expect(hosted.threads.call("threads.turnChanges", { id: threadId, checkpointId: "turn-2" })).rejects.toThrow("This turn's changes are not recorded yet.");
  });

  it.each([{ kind: "binary" }, { kind: "omitted", reason: "large", bytes: 2_000_000 }, { kind: "text", insertions: 3, deletions: 1 }])("retains a file's body and cut counts: $kind", async (body) => {
    const expected = {
      path: file.path,
      oldPath: null,
      status: file.status,
      body,
      patch: "@@ -1 +1 @@\n-old\n+new\n",
      cut: { shownLines: 3, totalLines: 7000 },
      note: "Only part of this diff was saved.",
    };
    answer = expected;
    expect(await hosted.threads.call("review.threadFileDiff", { threadId, path: FolderPath.parse(file.path) })).toMatchObject(expected);
  });
});

it("asks for a turn's saved changes and files by the server's turn, though the agent's events name it by their own id", async () => {
  stand.setBilling(email, { pro: true, standing: "live", at: "2099-01-01T00:00:00.000Z", monthlyLeftSeconds: 3600, packsLeftSeconds: 0 });
  stand.setSignIns(email, [{ agent: "claude" }]);
  const runId = `hosted:${threadId}`;
  await hosted.threads.call("runs.send", { runId, text: "Add a CSV export", messageId: "user-00000000-0000-4000-8000-000000000001" });
  stand.endTurn(threadId);
  const { events } = await hosted.threads.call("events.page", { runId, fromTurn: 0 });
  const ended = events.find((event) => event.type === "turn.completed");
  if (ended?.type !== "turn.completed") throw new Error("The turn must end.");
  const server = ended.turnId.replace(/-agent$/, "");
  expect(server).not.toBe(ended.turnId);
  answer = { ...recorded, comparison: undefined, missing: undefined, turnId: server, since: null };
  await hosted.threads.call("hosted.review.turn", { threadId, turnId: ended.turnId });
  answer = { path: file.path, oldPath: null, status: "modified", body: file.body, patch: "@@ -1 +1 @@\n-a\n+b", cut: null, note: null };
  await hosted.threads.call("hosted.review.file", { threadId, path: file.path, turnId: ended.turnId });
  expect(requests.map((request) => request.path.split("?")[0])).toEqual([`/hosted/threads/${threadId}/turns/${server}/changes`, `/hosted/threads/${threadId}/turns/${server}/changes/file`]);
});

it("reads one of the thread's commits as its changes and its files by the commit, and says so when the server can't", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const changes = { sha, parent: "89abcdef0123456789abcdef0123456789abcdef", totals: { files: 1, insertions: 3, deletions: 1 }, files: [file], unlisted: 0 };
  answer = changes;
  expect(await hosted.threads.call("hosted.review.commit", { threadId, sha })).toEqual(changes);
  answer = { path: file.path, oldPath: null, status: "modified", body: file.body, patch: "@@ -1 +1 @@\n-a\n+b", cut: null, note: null };
  await hosted.threads.call("hosted.review.file", { threadId, path: file.path, commit: sha });
  expect(requests.map((request) => request.path)).toEqual([`/hosted/threads/${threadId}/commits/${sha}/changes`, `/hosted/threads/${threadId}/commits/${sha}/changes/file?path=src%2Fexample.ts`]);
  // A commit whose changes the server doesn't keep is refused in its words; a server from before the route, in the app's.
  answer = { statusCode: 404, code: "commit_not_kept", message: "This commit was made before its changes were kept." };
  status = 404;
  await expect(hosted.threads.call("hosted.review.commit", { threadId, sha })).rejects.toThrow("This commit was made before its changes were kept.");
  answer = { statusCode: 404, message: `Cannot GET /hosted/threads/${threadId}/commits/${sha}/changes` };
  await expect(hosted.threads.call("hosted.review.commit", { threadId, sha })).rejects.toThrow("This commit's changes can't be read from here.");
});
