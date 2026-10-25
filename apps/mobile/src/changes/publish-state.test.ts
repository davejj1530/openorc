import type { PublishView } from "@openorc/client";
import type { Commit, PushState, ThreadSummary } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { barPills, noticeLine, openedNotice, settleLost, storedSubject } from "./publish-state";

const commit = (sha: string, subject: string): Commit => ({ sha, author: "QA", at: 1, subject });
const push = (over: Partial<PushState> = {}): PushState => ({ branch: "feat/x", blocked: null, published: true, unpushedCount: 0, unpushed: [], busy: false, ...over });
const thread = (over: Partial<ThreadSummary> = {}) => ({ prUrl: null, ...over }) as ThreadSummary;
const read = (over: { log?: Commit[]; push?: PushState; thread?: ThreadSummary } = {}) => ({ log: [commit("a1", "Start")], push: push(), thread: thread(), ...over });

describe("settleLost", () => {
  it("counts a commit as made when the head moved to a commit with the message's first line", () => {
    const lost = { action: "commit", message: "Fix pairing\n\nWhy it broke.", headBefore: "a1" } as const;
    expect(settleLost(lost, read({ log: [commit("b2c3d4e5f6", "Fix pairing"), commit("a1", "Start")] }))).toEqual({ kind: "done", notice: "Committed b2c3d4e" });
    expect(settleLost(lost, read())).toEqual({ kind: "not-done" });
    expect(settleLost(lost, read({ log: [commit("c3", "Something else")] }))).toEqual({ kind: "not-done" });
    expect(settleLost({ ...lost, headBefore: null }, read({ log: [commit("c3d4e5f6a7", "Fix pairing")] }))).toEqual({ kind: "done", notice: "Committed c3d4e5f" });
  });

  it("matches the subject as Git stores it: the first paragraph, its lines joined, trailing blanks off", () => {
    const lost = { action: "commit", message: "Fix the thing\nwith a second line  \n\nWhy.", headBefore: "a1" } as const;
    const stored = commit("b2c3d4e5f6", "Fix the thing with a second line");
    expect(settleLost(lost, read({ log: [stored, commit("a1", "Start")] }))).toEqual({ kind: "done", notice: "Committed b2c3d4e" });
    expect(settleLost(lost, read({ log: [stored, commit("x9", "Other"), commit("a1", "Start")] }))).toEqual({ kind: "done", notice: "Committed b2c3d4e" });
    expect(storedSubject("\n\n  Fix  the\tthing  \r\n   with detail \n \nbody")).toBe("  Fix  the\tthing    with detail");
    expect(storedSubject("")).toBe("");
  });

  it("reads a secret the Mac redacted from the log's subject as the message's own text", () => {
    const lost = { action: "commit", message: "Rotate ghp_abcdefghijklmnopqrstuvwxyz0123456789", headBefore: "a1" } as const;
    expect(settleLost(lost, read({ log: [commit("b2c3d4e5f6", "Rotate [redacted:github-token]"), commit("a1", "Start")] }))).toMatchObject({ kind: "done" });
    expect(settleLost(lost, read({ log: [commit("b2c3d4e5f6", "Revert [redacted:github-token]"), commit("a1", "Start")] }))).toEqual({ kind: "not-done" });
  });

  it("counts a subject a hook added to as made only right on the old head, and one it rewrote as not done", () => {
    const lost = { action: "commit", message: "Fix pairing", headBefore: "a1" } as const;
    expect(settleLost(lost, read({ log: [commit("b2c3d4e5f6", "QA-12: Fix pairing"), commit("a1", "Start")] }))).toEqual({ kind: "done", notice: "Committed b2c3d4e" });
    expect(settleLost(lost, read({ log: [commit("b2", "QA-12: Fix pairing"), commit("x9", "Other"), commit("a1", "Start")] }))).toEqual({ kind: "not-done" });
    expect(settleLost(lost, read({ log: [commit("b2", "chore: tidy"), commit("a1", "Start")] }))).toEqual({ kind: "not-done" });
    // The exact subject counts even with a commit in between, as one made from the Mac at the same moment would put there.
    expect(settleLost(lost, read({ log: [commit("b2c3d4e5f6", "Fix pairing"), commit("x9", "Other"), commit("a1", "Start")] }))).toMatchObject({ kind: "done" });
    expect(settleLost(lost, read({ log: [commit("b2", "Fix pairing"), commit("x9", "Other")] }))).toEqual({ kind: "not-done" });
  });

  it("counts a push as made once origin lacks nothing, and a pull request once the thread has one", () => {
    expect(settleLost({ action: "push" }, read())).toEqual({ kind: "done", notice: "Pushed feat/x to origin" });
    expect(settleLost({ action: "push" }, read({ push: push({ unpushedCount: 1 }) }))).toEqual({ kind: "not-done" });
    expect(settleLost({ action: "pr" }, read({ thread: thread({ prUrl: "https://github.com/o/r/pull/12" }) }))).toEqual({ kind: "done", notice: "Opened pull request #12" });
    expect(settleLost({ action: "pr" }, read())).toEqual({ kind: "not-done" });
  });
});

describe("openedNotice", () => {
  it("names the pull request by number, as a URL wraps three times at phone width", () => {
    expect(openedNotice("https://github.com/fake/openorc-qa/pull/7")).toBe("Opened pull request #7");
    expect(openedNotice("https://example.com/pr")).toBe("Opened pull request");
  });
});

describe("barPills", () => {
  const idle = (label: string) => ({ label, reason: null, running: false });
  const view = (over: Partial<PublishView>): PublishView => ({ commit: idle("Commit"), push: null, pushBlocked: null, pullRequest: null, next: null, ...over });

  it("puts the next step in ink and the one after it in plain fill", () => {
    expect(barPills(view({ push: idle("Push 1 commit"), next: "commit" }), 3)).toEqual([
      { action: "commit", label: "Commit", reason: null, running: false, ink: true },
      { action: "push", label: "Push 1 commit", reason: null, running: false, ink: false },
    ]);
    expect(barPills(view({ push: idle("Publish branch"), next: "push" }), 0)).toEqual([{ action: "push", label: "Publish branch", reason: null, running: false, ink: true }]);
    expect(barPills(view({ pullRequest: { kind: "open", head: "feat/x", step: idle("PR") }, next: "pr" }), 0)).toEqual([{ action: "pr", label: "PR", reason: null, running: false, ink: true }]);
  });

  it("keeps GitHub's compare page and a pull request that exists in plain fill", () => {
    expect(barPills(view({ pullRequest: { kind: "compare", url: "https://github.com/o/r/compare", step: idle("PR") }, next: "pr" }), 0)).toEqual([
      { action: "pr", label: "PR", reason: null, running: false, ink: false },
    ]);
    const exists = { kind: "exists", url: "https://github.com/o/r/pull/1", state: "merged" } as const;
    expect(barPills(view({ pullRequest: exists }), 0)).toEqual([{ action: "pr", label: "PR merged", reason: null, running: false, ink: false }]);
    expect(barPills(view({ pullRequest: exists, next: "commit" }), 2)).toEqual([
      { action: "commit", label: "Commit", reason: null, running: false, ink: true },
      { action: "pr", label: "PR merged", reason: null, running: false, ink: false },
    ]);
  });

  it("shows nothing when there is nothing to commit, push or open", () => {
    expect(barPills(view({}), 0)).toEqual([]);
    expect(barPills(view({ commit: null }), 4)).toEqual([]);
  });
});

describe("noticeLine", () => {
  const base = { publishing: { kind: "idle" } as const, asked: null, team: false, pushBlocked: null, bar: true, unpushed: false, uncommitted: 0, mac: "Studio" };
  const notice = (action: "commit" | "push" | "pr", tone: "muted" | "bad", text: string) => ({ kind: "notice", action, text, tone, details: tone === "bad" ? text : null }) as const;

  it("says a write was lost until reads settle it, before anything else", () => {
    expect(noticeLine({ ...base, publishing: { kind: "lost", lost: { action: "push" } }, asked: "Wait for Codex to finish." })).toEqual({
      text: "Lost Studio before it answered.",
      tone: "muted",
      details: null,
    });
  });

  it("answers a press on a dim pill, then a team's thread, then what the last write did", () => {
    expect(noticeLine({ ...base, asked: "Wait for Codex to finish.", publishing: notice("pr", "muted", "Opened pull request #2") })).toEqual({
      text: "Wait for Codex to finish.",
      tone: "muted",
      details: null,
    });
    expect(noticeLine({ ...base, team: true, bar: false })).toEqual({ text: "Publish a team's work on your Mac.", tone: "muted", details: null });
    expect(noticeLine({ ...base, publishing: notice("pr", "muted", "Opened pull request #2") })).toMatchObject({ text: "Opened pull request #2" });
  });

  it("holds a push's success until new commits arrive, and its failure until nothing is left to push", () => {
    const pushed = notice("push", "muted", "Pushed feat/x to origin");
    expect(noticeLine({ ...base, publishing: pushed })).toMatchObject({ text: "Pushed feat/x to origin" });
    expect(noticeLine({ ...base, publishing: pushed, unpushed: true })).toBeNull();
    const refused = notice("push", "bad", "origin has newer commits on feat/x.");
    expect(noticeLine({ ...base, publishing: refused, unpushed: true })).toEqual({ text: "origin has newer commits on feat/x.", tone: "bad", details: "origin has newer commits on feat/x." });
    expect(noticeLine({ ...base, publishing: refused })).toBeNull();
  });

  it("holds Committed until new changes arrive, and leaves the sheets' own failures to them", () => {
    expect(noticeLine({ ...base, publishing: notice("commit", "muted", "Committed a1b2c3d"), unpushed: true })).toMatchObject({ text: "Committed a1b2c3d" });
    expect(noticeLine({ ...base, publishing: notice("commit", "muted", "Committed a1b2c3d"), uncommitted: 2 })).toBeNull();
    expect(noticeLine({ ...base, publishing: notice("commit", "bad", "hook failed") })).toBeNull();
    expect(noticeLine({ ...base, publishing: notice("pr", "bad", "gh pr create failed") })).toBeNull();
  });

  it("says why nothing can be pushed while the bar shows", () => {
    expect(noticeLine({ ...base, pushBlocked: "This repository has no origin remote to push to." })).toMatchObject({ text: "This repository has no origin remote to push to.", tone: "muted" });
    expect(noticeLine({ ...base, pushBlocked: "This repository has no origin remote to push to.", bar: false })).toBeNull();
  });
});
