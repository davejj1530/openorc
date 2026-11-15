import { expect, it } from "vitest";
import { PULL_REQUEST_AUTHOR_LIMIT, pullRequestRpcParams } from "./pull-requests.js";

const list = pullRequestRpcParams["pulls.list"];
const asked = (narrowing: Record<string, unknown>) => list.safeParse({ projectId: "p", state: "open", ...narrowing }).success;

it("takes the people a filter names: logins, apps, managed users and you", () => {
  expect(asked({ authors: ["ada", "app/dependabot", "jdoe_acme", "renovate[bot]", "@me"], assignee: "@me" })).toBe(true);
  expect(asked({ authors: ["-ada"] })).toBe(false);
  expect(asked({ authors: ["ada lovelace"] })).toBe(false);
  expect(asked({ authors: Array.from({ length: PULL_REQUEST_AUTHOR_LIMIT + 1 }, (_, i) => `a${i}`) })).toBe(false);
});

it("refuses a label or milestone a search can't quote, and anything it doesn't know", () => {
  expect(asked({ labels: ["good first issue", "area:repo"], milestone: "v1.2" })).toBe(true);
  expect(asked({ labels: ['say "hi"'] })).toBe(false);
  expect(asked({ milestone: "v1\nv2" })).toBe(false);
  expect(asked({ labels: [] })).toBe(false);
  expect(asked({ reviewer: "ada" })).toBe(false);
});
