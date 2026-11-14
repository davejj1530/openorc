import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderPath } from "@openorc/protocol";
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
let requests: { path: string; body: unknown; space: string | null }[];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  threadId = stand.addThread(email, { projectId: null, title: "Saved changes" });
  answer = recorded;
  status = 200;
  requests = [];
  const { deps, browser } = hostDeps(stand, newDevice(), {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/changes") || /\/(commit|push|pull-request)$/.test(url.pathname)) {
        requests.push({ path: url.pathname + url.search, body: typeof init?.body === "string" ? JSON.parse(init.body) : null, space: new Headers(init?.headers).get("x-openorc-space") });
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
afterEach(async () => {
  hosted.close();
  await stand.close();
});

describe("cloud review bridges", () => {
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
