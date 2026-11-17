import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { CLOUD_PROJECT } from "./translate.js";
import { hostDeps, newDevice, signInAs, type Seen } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

/*
 * A review of a pull request of a project only OpenOrc Cloud has: the person's draft is the server's, read and changed
 * in the project's space by the server's own project id, in the app's shapes, and each change has the app read it again.
 */
const email = "reader@example.com";
const at = "2026-11-18T01:00:00.000Z";
let stand: StandIn;
let hosted: Hosted;
let seen: Seen;
let project: string;
let requests: { method: string; path: string; body: unknown; space: string | null }[];
let answer: unknown;

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  project = stand.addProject(email, { name: "app", fullName: "acme/app" });
  requests = [];
  answer = null;
  const host = hostDeps(stand, newDevice(), {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (!url.pathname.startsWith("/hosted/pull-reviews")) return fetch(input, init);
      requests.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        space: new Headers(init?.headers).get("x-openorc-space"),
      });
      return answer === null ? new Response(null, { status: 204 }) : Response.json(answer);
    },
  });
  seen = host.seen;
  hosted = createHosted(host.deps);
  await hosted.start();
  await signInAs(hosted, host.browser, email);
  await vi.waitFor(() => expect(hosted.threads.project(`${CLOUD_PROJECT}${project}`)).not.toBeNull());
});
afterEach(async () => {
  hosted.close();
  await stand.close();
});

const key = () => ({ projectId: `${CLOUD_PROJECT}${project}`, number: 7 });
const comment = {
  id: "c1",
  path: "app.ts",
  startLine: null,
  startSide: null,
  line: 3,
  side: "new",
  lineText: "  const retries = 3;",
  body: "Name this constant.",
  author: { agent: "claude", model: "claude-opus-5-5" },
  createdAt: at,
};

it("reads the person's draft by the server's project, in the app's shapes and under the app's project", async () => {
  answer = { review: { projectId: project, number: 7, commitId: "h".repeat(40), summary: "", modelSummary: "Looks close.", threadId: "t-1", baseCommit: null, comments: [comment], updatedAt: at } };
  const review = await hosted.pullReviews.get(key());
  expect(review).toMatchObject({
    projectId: key().projectId,
    threadId: "t-1",
    modelSummary: "Looks close.",
    updatedAt: Date.parse(at),
    comments: [{ id: "c1", createdAt: Date.parse(at), author: { agent: "claude" } }],
  });
  expect(requests[0]).toMatchObject({ method: "GET", path: `/hosted/pull-reviews/${project}/7`, space: `personal-${email}` });
  answer = { review: null };
  expect(await hosted.pullReviews.get(key())).toBeNull();
});

it("starts a model on the head the app read, writes the person's comments and summary, and has the app read the draft again after each", async () => {
  answer = { threadId: "t-1" };
  expect(await hosted.pullReviews.start(key(), "h".repeat(40), { agent: "codex", model: "gpt-5.5", effort: "high" })).toEqual({ threadId: "t-1" });
  answer = comment;
  expect(
    await hosted.pullReviews.comment({ ...key(), commitId: "h".repeat(40) }, { path: "app.ts", startLine: null, startSide: null, line: 3, side: "new", lineText: "x", body: "Name this constant." }),
  ).toMatchObject({ createdAt: Date.parse(at) });
  answer = null;
  await hosted.pullReviews.setSummary(key(), "h".repeat(40), "Two small fixes.");
  await hosted.pullReviews.posted(key(), { comments: [{ ...comment, author: null, createdAt: 1, side: "new" }], summary: "Two small fixes.", modelSummary: null });
  expect(requests.map(({ method, path, body }) => [method, path, body])).toEqual([
    ["POST", "/hosted/pull-reviews", { projectId: project, number: 7, headSha: "h".repeat(40), reviewer: { agent: "codex", model: "gpt-5.5", effort: "high" } }],
    ["POST", `/hosted/pull-reviews/${project}/7/comments`, expect.objectContaining({ commitId: "h".repeat(40), path: "app.ts", body: "Name this constant." })],
    ["PUT", `/hosted/pull-reviews/${project}/7/summary`, { commitId: "h".repeat(40), summary: "Two small fixes." }],
    ["POST", `/hosted/pull-reviews/${project}/7/posted`, { comments: [{ id: "c1", body: "Name this constant." }], summary: "Two small fixes.", modelSummary: null }],
  ]);
  expect(seen.pushes.filter((push) => JSON.stringify(push) === JSON.stringify({ type: "invalidate", keys: ["pull-reviews"] }))).toHaveLength(4);
});

it("has the app read the draft again when the server says on the socket that it changed", async () => {
  const before = seen.pushes.length;
  stand.tell(email, ["pull-reviews"]);
  await vi.waitFor(() => expect(seen.pushes.slice(before)).toContainEqual({ type: "invalidate", keys: ["pull-reviews"] }));
});

it("refuses a project OpenOrc Cloud doesn't have, asking nothing", async () => {
  await expect(hosted.pullReviews.get({ projectId: "mac-only", number: 7 })).rejects.toThrow("This project isn't on OpenOrc Cloud.");
  expect(requests).toEqual([]);
});
