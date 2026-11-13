import { describe, expect, it } from "vitest";
import { defaultOrclingLook, type ModelOption, type Orcling } from "@openorc/protocol";
import { draftAuthor, offeredSummary, pullRequestTone, pullRow, withModelSummary } from "./pull-requests";

describe("pull request presentation", () => {
  it("names a draft comment by the Orcling that wrote it and the model it ran on", () => {
    const models: ModelOption[] = [{ id: "gpt-6-sol", label: "GPT-6 Sol", agent: "codex", isDefault: true, efforts: ["low", "high"], defaultEffort: "low" }];
    const gloop: Orcling = {
      id: "gloop",
      name: "Gloop",
      look: defaultOrclingLook,
      settings: { agent: "codex", model: "gpt-6-sol", effort: "low", fastMode: false },
      claudeAccountId: "claude-cli",
      permission: "approve",
      wakes: [],
      threadId: "home",
      createdAt: 1,
      updatedAt: 1,
    };
    expect(draftAuthor(null, models, [gloop])).toBe("You");
    expect(draftAuthor({ agent: "codex", model: "gpt-6-sol" }, models, [gloop])).toBe("GPT-6 Sol");
    expect(draftAuthor({ agent: "codex", model: "gpt-6-sol", orclingId: "gloop" }, models, [gloop])).toBe("Gloop - GPT-6 Sol");
    // A deleted Orcling leaves the model that ran.
    expect(draftAuthor({ agent: "codex", model: "gpt-6-sol", orclingId: "gone" }, models, [gloop])).toBe("GPT-6 Sol");
  });

  it("shows a draft as its own state until it is merged or closed", () => {
    expect(pullRequestTone({ state: "open", isDraft: true })).toBe("draft");
    expect(pullRequestTone({ state: "open", isDraft: false })).toBe("open");
    expect(pullRequestTone({ state: "merged", isDraft: true })).toBe("merged");
  });
});

describe("the model's summary beside the user's", () => {
  it("is offered until the summary being written includes it", () => {
    expect(offeredSummary("Needs a test for retries.", "Looks close; add backoff.")).toBe("Looks close; add backoff.");
    expect(offeredSummary(withModelSummary("Needs a test for retries.", "Looks close; add backoff."), "Looks close; add backoff.")).toBeNull();
    expect(offeredSummary("Anything", null)).toBeNull();
  });

  it("goes below the user's summary, or stands alone when there is none", () => {
    expect(withModelSummary("Mine.\n", "The model's.")).toBe("Mine.\n\nThe model's.");
    expect(withModelSummary("  ", "The model's.")).toBe("The model's.");
  });
});

describe("pullRow", () => {
  const none = { askedOfYou: false, yours: false, draftComments: 0, reviewing: null, restingThread: null };
  const open = { state: "open" as const, isDraft: false, reviewDecision: null };
  it("says a state nobody waits on in quiet words, with no move", () => {
    expect(pullRow({ ...open, reviewDecision: "approved" }, none)).toEqual({ status: { kind: "word", word: "Approved", tone: "ok" }, move: null, yourMove: false });
    expect(pullRow({ ...open, isDraft: true }, none).status).toEqual({ kind: "word", word: "Draft", tone: "muted" });
    expect(pullRow({ ...open, state: "merged" }, { ...none, askedOfYou: true })).toMatchObject({ status: { word: "Merged" }, move: null });
  });
  it("puts a reviewer at work before any move, and a draft waiting here before the review GitHub asks for", () => {
    expect(pullRow(open, { ...none, askedOfYou: true, draftComments: 3, reviewing: "Rini" })).toEqual({ status: { kind: "reviewing", who: "Rini" }, move: null, yourMove: false });
    expect(pullRow(open, { ...none, askedOfYou: true, draftComments: 1 })).toMatchObject({ status: { word: "1 draft comment", tone: "attention" }, move: { kind: "finish" }, yourMove: true });
    expect(pullRow(open, { ...none, askedOfYou: true })).toMatchObject({ status: { word: "Review required", tone: "attention" }, move: { kind: "review" } });
  });
  it("leads to the thread of the person's own pull request with changes requested only while that thread rests", () => {
    const changes = { ...open, reviewDecision: "changes_requested" as const };
    expect(pullRow(changes, { ...none, yours: true, restingThread: "t" }).move).toEqual({ kind: "open-thread", threadId: "t" });
    expect(pullRow(changes, { ...none, yours: true })).toMatchObject({ move: null, yourMove: true });
    expect(pullRow(changes, none)).toMatchObject({ status: { tone: "muted" }, yourMove: false });
  });
});
