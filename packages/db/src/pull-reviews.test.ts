import { describe, expect, it } from "vitest";
import { Db } from "./database.js";
import { pullReviews } from "./pull-reviews.js";
import { projects, threads } from "./repos.js";

function setup() {
  const db = Db.memory();
  const project = projects.insert(db, { name: "App", rootPath: "/tmp/pull-review-app", gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
  return { db, key: { projectId: project.id, number: 7 }, project };
}

const line = { path: "src/app.ts", startLine: null, startSide: null, line: 12, side: "new" as const, lineText: "  return server;", body: "Close the server on error." };

describe("pull request reviews", () => {
  it("keeps one draft per pull request with its comments in order", () => {
    const { db, key } = setup();
    expect(pullReviews.get(db, key)).toBeNull();
    const review = pullReviews.open(db, key, "a".repeat(40));
    expect(review).toMatchObject({ commitId: "a".repeat(40), summary: "", threadId: null, comments: [] });
    // Opening again returns the same review, still on its first commit.
    expect(pullReviews.open(db, key, "b".repeat(40)).commitId).toBe("a".repeat(40));

    const yours = pullReviews.addComment(db, key, { ...line, author: null });
    const agent = pullReviews.addComment(db, key, { ...line, startLine: 10, startSide: "old", body: "Keep the guard.", author: { agent: "claude", model: "claude-opus-5-5" } });
    expect(pullReviews.get(db, key)!.comments).toEqual([yours, agent]);
    expect(agent.author).toEqual({ agent: "claude", model: "claude-opus-5-5" });

    expect(pullReviews.editComment(db, key, yours.id, "Close the server when listen fails.")!.body).toBe("Close the server when listen fails.");
    expect(pullReviews.editComment(db, { ...key, number: 8 }, yours.id, "Elsewhere")).toBeNull();
    pullReviews.removeComment(db, key, agent.id);
    expect(pullReviews.get(db, key)!.comments.map((comment) => comment.id)).toEqual([yours.id]);

    pullReviews.update(db, key, { summary: "Nearly there.", commitId: "c".repeat(40) });
    expect(pullReviews.get(db, key)).toMatchObject({ summary: "Nearly there.", commitId: "c".repeat(40) });
  });

  it("finds a review by its conversation and forgets a deleted conversation", () => {
    const { db, key, project } = setup();
    const thread = threads.insert(db, { projectId: project.id, title: "Review #7", agent: "claude", model: null, mode: "plan", permissionMode: "review" });
    pullReviews.open(db, key, "a".repeat(40));
    pullReviews.update(db, key, { threadId: thread.id });
    expect(pullReviews.forThread(db, thread.id)?.number).toBe(7);
    db.stmt("DELETE FROM threads WHERE id = ?").run(thread.id);
    expect(pullReviews.get(db, key)?.threadId).toBeNull();
  });

  it("empties a posted draft but keeps its conversation for the next round", () => {
    const { db, key, project } = setup();
    const thread = threads.insert(db, { projectId: project.id, title: "Review #7", agent: "claude", model: null, mode: "plan", permissionMode: "review" });
    pullReviews.open(db, key, "a".repeat(40));
    pullReviews.update(db, key, { threadId: thread.id, summary: "Nearly there." });
    pullReviews.addComment(db, key, { ...line, author: null });
    pullReviews.clearDraft(db, key);
    expect(pullReviews.get(db, key)).toMatchObject({ commitId: "a".repeat(40), summary: "", threadId: thread.id, comments: [] });
    expect(db.stmt("SELECT COUNT(*) AS count FROM pull_request_review_comments").get()).toEqual({ count: 0 });
  });

  it("removes only what a posted review carried", () => {
    const { db, key } = setup();
    pullReviews.open(db, key, "a".repeat(40));
    pullReviews.update(db, key, { summary: "Nearly there." });
    const kept = pullReviews.addComment(db, key, { ...line, author: null });
    pullReviews.addComment(db, key, { ...line, body: "Posted as written.", author: null });
    const sent = pullReviews.get(db, key)!;
    pullReviews.editComment(db, key, kept.id, "Edited while posting.");
    pullReviews.addComment(db, key, { ...line, body: "Added while posting.", author: null });
    pullReviews.clearPosted(db, key, sent);
    expect(pullReviews.get(db, key)).toMatchObject({ summary: "", comments: [{ id: kept.id, body: "Edited while posting." }, { body: "Added while posting." }] });
    pullReviews.update(db, key, { summary: "Rewritten while posting." });
    pullReviews.clearPosted(db, key, { summary: "Nearly there.", modelSummary: null, comments: [] });
    expect(pullReviews.get(db, key)?.summary).toBe("Rewritten while posting.");
  });
});
