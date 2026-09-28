import { describe, expect, it } from "vitest";
import { pullRequestNumber, pullRequestTone } from "./pull-requests";

describe("pull request presentation", () => {
  it("reads the number from a pull request's address only", () => {
    expect(pullRequestNumber("https://github.com/acme/app/pull/3")).toBe(3);
    expect(pullRequestNumber("https://github.com/acme/app/pull/42#pullrequestreview-9")).toBe(42);
    expect(pullRequestNumber("https://github.com/acme/app/pull/42/files")).toBe(42);
    expect(pullRequestNumber("https://github.com/acme/app/issues/3")).toBeNull();
    expect(pullRequestNumber("https://github.com/acme/app/pull/3x")).toBeNull();
    expect(pullRequestNumber(null)).toBeNull();
  });

  it("shows a draft as its own state until it is merged or closed", () => {
    expect(pullRequestTone({ state: "open", isDraft: true })).toBe("draft");
    expect(pullRequestTone({ state: "open", isDraft: false })).toBe("open");
    expect(pullRequestTone({ state: "merged", isDraft: true })).toBe("merged");
  });
});
