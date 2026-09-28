import { describe, expect, it } from "vitest";
import { pullRequestNumber, pullRequestTarget, pullRequestTone } from "./pull-requests";

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

describe("a new pull request's target", () => {
  const known = { branches: ["main", "dev", "feat/login"], defaultBranch: "main" };

  it("targets the branch the work started from while GitHub has it", () => {
    expect(pullRequestTarget({ started: "dev", projectDefault: "main", head: "feat/login", branches: undefined })).toBe("dev");
    expect(pullRequestTarget({ started: "dev", projectDefault: "main", head: "feat/login", branches: known })).toBe("dev");
    expect(pullRequestTarget({ started: "release/1", projectDefault: "main", head: "feat/login", branches: known })).toBe("main");
  });

  it("falls back to GitHub's default branch, and never targets the branch it opens from", () => {
    expect(pullRequestTarget({ started: null, projectDefault: "trunk", head: "feat/login", branches: known })).toBe("main");
    expect(pullRequestTarget({ started: "dev", projectDefault: "main", head: "dev", branches: known })).toBe("main");
    expect(pullRequestTarget({ started: null, projectDefault: null, head: "main", branches: known })).toBeNull();
  });
});
