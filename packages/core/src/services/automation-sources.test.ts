import { expect, it } from "vitest";
import { pullsFrom } from "./automation-sources.js";

const listed = (checks: unknown[]) =>
  JSON.stringify([
    { number: 7, title: "Ship the header", url: "https://github.com/studio/app/pull/7", headRefName: "header", headRefOid: "abc1234", author: { login: "mira" }, statusCheckRollup: checks },
  ]);
const run = (name: string, status: string, conclusion: string | null) => ({ __typename: "CheckRun", name, status, conclusion });
const status = (context: string, state: string) => ({ __typename: "StatusContext", context, state });

it("reads a pull request's failed checks by name, of both kinds GitHub lists, once every check has finished", () => {
  expect(pullsFrom(listed([run("Lint", "COMPLETED", "FAILURE"), run("Build", "COMPLETED", "SUCCESS"), run("Docs", "COMPLETED", "SKIPPED"), status("deploy/preview", "ERROR")]))).toEqual([
    { number: 7, title: "Ship the header", url: "https://github.com/studio/app/pull/7", branch: "header", sha: "abc1234", author: "mira", failed: ["Lint", "deploy/preview"], settled: true },
  ]);
});

it("holds a pull request unsettled while a check of either kind is still running", () => {
  expect(pullsFrom(listed([run("Lint", "COMPLETED", "FAILURE"), run("Build", "IN_PROGRESS", null)]))[0]).toMatchObject({ failed: ["Lint"], settled: false });
  expect(pullsFrom(listed([status("deploy/preview", "PENDING")]))[0]).toMatchObject({ failed: [], settled: false });
});

it("takes a pull request with no checks as settled with none failed, and leaves out what is not a pull request", () => {
  expect(pullsFrom(listed([]))[0]).toMatchObject({ failed: [], settled: true });
  expect(pullsFrom(JSON.stringify([{ title: "No number" }, { number: 3, url: "https://github.com/studio/app/pull/3" }]))).toMatchObject([
    { number: 3, title: "", author: "", failed: [], settled: true },
  ]);
});
