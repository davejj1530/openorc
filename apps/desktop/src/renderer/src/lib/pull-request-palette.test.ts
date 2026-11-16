import { describe, expect, it } from "vitest";
import type { PullRequestSummary } from "@openorc/protocol";
import { filterTokens, paletteGroups, type PaletteSources, type PaletteTarget } from "./pull-request-palette";
import { noPullRequestFilters, type PullRequestFilters } from "./pull-requests";

const pull = (author: string, labels: string[] = []) => ({ author, labels: labels.map((name) => ({ name, color: "d73a4a", description: "" })) }) as PullRequestSummary;
const sources: PaletteSources = {
  pulls: [pull("mara", ["bug"]), pull("pip", ["docs"])],
  labels: [
    { value: "bug", name: "bug", color: "d73a4a", detail: "Something broke" },
    { value: "performance", name: "performance", color: "fbca04" },
  ],
  assignees: [{ value: "atlas", name: "atlas" }],
  milestones: [
    { value: "March cleanup", name: "March cleanup" },
    { value: "v1", name: "v1", detail: "Closed" },
  ],
  projects: [{ value: "acme/7", name: "Roadmap", detail: "acme" }],
};
const target = (filters: Partial<PullRequestFilters> = {}, query = ""): PaletteTarget => ({ filters: { ...noPullRequestFilters, ...filters }, query });
const rows = (groups: ReturnType<typeof paletteGroups>) => groups.map((group) => [group.label, group.items.map((item) => `${item.facet} ${item.text}`)]);

describe("the filter palette", () => {
  it("opens as a short menu of every filter, you first among the people", () => {
    const groups = paletteGroups(target(), sources, "");
    expect(groups.map((group) => group.label)).toEqual(["People", "Labels", "Reviews", "Milestones", "Projects"]);
    expect(groups[0]!.items.slice(0, 2).map((item) => `${item.facet} ${item.text}`)).toEqual(["Author you", "Assignee you"]);
    expect(groups.every((group) => group.items.length <= 5)).toBe(true);
  });

  it("finds what was typed in any facet, after a search of titles", () => {
    expect(rows(paletteGroups(target(), sources, "ma"))).toEqual([
      ["Search", ["Search ma"]],
      ["People", ["Author mara", "Assignee mara"]],
      ["Labels", ["Label performance"]],
      ["Milestones", ["Milestone March cleanup"]],
      ["Projects", ["Project Roadmap"]],
    ]);
    // A login typed with its @ is offered even when no pull request names it yet.
    expect(rows(paletteGroups(target(), sources, "@octocat"))[1]).toEqual(["People", ["Author octocat", "Assignee octocat"]]);
    expect(rows(paletteGroups(target(), sources, "review approved"))).toEqual([
      ["Search", ["Search review approved"]],
      ["Reviews", ["Review Approved review"]],
    ]);
  });

  it("holds back what a group can't show, and shows more of it each time it is asked", () => {
    const many: PaletteSources = { ...sources, labels: Array.from({ length: 23 }, (_, index) => ({ value: `area-${index + 10}`, name: `area-${index + 10}` })) };
    const labels = (asked: Record<string, number>, input = "") => paletteGroups(target(), many, input, asked).find((group) => group.label === "Labels")!;
    // 23 labels, the two on pull requests, and the row for none.
    expect(labels({})).toMatchObject({ more: 21 });
    expect(labels({}).items).toHaveLength(5);
    expect(labels({ Labels: 1 })).toMatchObject({ more: 11 });
    expect(labels({ Labels: 3 }).items).toHaveLength(26);
    expect(labels({ Labels: 3 }).more).toBe(0);
    // Typing starts from more rows, and asking adds to those.
    expect(labels({}, "area")).toMatchObject({ more: 15 });
    expect(labels({ Labels: 1 }, "area").items).toHaveLength(18);
    // Asking one group for more leaves the others as they were.
    expect(paletteGroups(target(), many, "", { Labels: 2 }).find((group) => group.label === "Reviews")).toMatchObject({ more: 3 });
  });

  it("finds you by me or @me, and offers only what a filter can send", () => {
    for (const typed of ["me", "@me"]) expect(rows(paletteGroups(target(), sources, typed))[1]).toEqual(["People", ["Author you", "Assignee you"]]);
    const odd: PaletteSources = {
      ...sources,
      pulls: [pull("jdoe_acme", ['say "hi"']), pull("not a login")],
      labels: [...sources.labels, { value: "none", name: "none" }],
    };
    const groups = paletteGroups(target(), odd, "", { People: 2, Labels: 2 });
    expect(groups[0]!.items.map((item) => item.key)).toContain("author:jdoe_acme");
    expect(groups.flatMap((group) => group.items).map((item) => item.text)).not.toContain('say "hi"');
    expect(groups.flatMap((group) => group.items).map((item) => item.text)).not.toContain("not a login");
    // A label named none and the row for unlabeled pull requests are told apart.
    expect(groups[1]!.items.map((item) => item.key)).toEqual(expect.arrayContaining(["label:none", "no:label"]));
  });

  it("offers an app as an author but not as an assignee, which an app can't be", () => {
    const keys = paletteGroups(target(), { ...sources, pulls: [pull("app/dependabot")] }, "dependabot")
      .flatMap((group) => group.items)
      .map((item) => item.key);
    expect(keys).toContain("author:app/dependabot");
    expect(keys).not.toContain("assignee:app/dependabot");
  });

  it("adds what a row names, and doesn't offer it again", () => {
    const [, people] = paletteGroups(target(), sources, "mara");
    const added = people!.items[0]!.apply(target({ authors: ["pip"] }));
    expect(added.filters.authors).toEqual(["pip", "mara"]);
    expect(rows(paletteGroups(added, sources, "mara"))[1]).toEqual(["People", ["Assignee mara"]]);
    const unlabeled = paletteGroups(target({ labels: ["bug"] }), sources, "unlabeled")
      .flatMap((group) => group.items)
      .find((item) => item.key === "no:label")!;
    expect(unlabeled.apply(target({ labels: ["bug"] })).filters).toMatchObject({ labels: [], missing: ["label"] });
    const search = paletteGroups(target(), sources, "retry")[0]!.items[0]!;
    expect(search.apply(target()).query).toBe("retry");
  });

  it("lists the filters set as tokens in the order they read, each taking only itself off", () => {
    const set = target({ authors: ["@me", "ada"], labels: ["bug"], review: "approved", project: "acme/7", missing: ["milestone"] }, "retry");
    const tokens = filterTokens(set, new Map([["acme/7", "Roadmap"]]));
    expect(tokens.map((token) => `${token.facet}: ${token.text}`)).toEqual(["Author: you, ada", "Label: bug", "Review: Approved review", "Milestone: none", "Project: Roadmap", "Search: retry"]);
    expect(tokens[0]!.remove(set).filters.authors).toEqual([]);
    expect(tokens[3]!.remove(set).filters.missing).toEqual([]);
    expect(tokens.at(-1)!.remove(set)).toEqual({ ...set, query: "" });
  });
});
