import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultOrclingLook, type ModelOption, type Orcling } from "@openorc/protocol";
import type { PullRequestSummary } from "@openorc/protocol";
import {
  activeView,
  authorChoices,
  builtInViews,
  draftAuthor,
  hasPullRequestFilters,
  isMissing,
  labelChoices,
  listOf,
  mergedChoices,
  noPullRequestFilters,
  offeredSummary,
  pullRequestNarrowing,
  pullRequestTone,
  readPullRequestFilters,
  readDefaultViewId,
  readPullRequestViews,
  rememberListState,
  sortLabel,
  startingListState,
  suggestedViewName,
  typedLogin,
  withMissing,
  withModelSummary,
  writeDefaultViewId,
  writePullRequestFilters,
  writePullRequestViews,
  type PullRequestFilters,
  type PullRequestListState,
  type PullRequestView,
} from "./pull-requests";

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

describe("the pull request list's filters and views", () => {
  const pull = (author: string, labels: string[] = []) => ({ author, labels: labels.map((name) => ({ name, color: "ededed", description: "" })) }) as PullRequestSummary;
  const filters = (patch: Partial<PullRequestFilters>): PullRequestFilters => ({ ...noPullRequestFilters, ...patch });
  const list = (patch: Partial<PullRequestListState>): PullRequestListState => ({ state: "open", filters: noPullRequestFilters, query: "", base: "builtin-all", ...patch });

  it("asks only for what is set, newest first being no ask at all", () => {
    expect(pullRequestNarrowing(noPullRequestFilters)).toEqual({});
    const set = filters({ authors: ["ada", "@me"], labels: ["bug"], assignee: "@me", milestone: "v2", project: "acme/7", review: "approved", sort: "oldest" });
    expect(pullRequestNarrowing(set)).toEqual({ authors: ["ada", "@me"], labels: ["bug"], assignee: "@me", milestone: "v2", project: "acme/7", review: "approved", sort: "oldest" });
    expect(hasPullRequestFilters(filters({ sort: "newest" }))).toBe(false);
    expect(hasPullRequestFilters(filters({ sort: "most_commented" }))).toBe(true);
  });

  it("asks for something missing in place of choosing it, and back", () => {
    const missing = withMissing(filters({ labels: ["bug"], milestone: "v2" }), "label", true);
    expect(missing).toMatchObject({ labels: [], milestone: "v2", missing: ["label"] });
    expect(withMissing(withMissing(missing, "milestone", true), "label", false)).toMatchObject({ milestone: null, missing: ["milestone"] });
    expect(isMissing(missing, "label")).toBe(true);
  });

  it("offers every author and label once, whatever the case, by name", () => {
    expect(authorChoices(["Zed"], [pull("ada"), pull("zed"), pull("ada")])).toEqual(["ada", "Zed"]);
    expect(labelChoices(["wip"], [{ value: "Bug", name: "Bug", color: "d73a4a" }], [pull("ada", ["bug", "docs"])])).toEqual(["Bug", "docs", "wip"]);
    expect(
      mergedChoices([
        [{ value: "v1", name: "v1" }],
        [
          { value: "V1", name: "V1" },
          { value: "v2", name: "v2" },
        ],
      ]),
    ).toEqual([
      { value: "v1", name: "v1" },
      { value: "v2", name: "v2" },
    ]);
  });

  it("names the order only when it isn't newest", () => {
    expect(sortLabel("newest")).toBeNull();
    expect(sortLabel("least_recently_updated")).toBe("Least recently updated");
    expect(sortLabel("reactions_rocket")).toBe("Most rockets");
  });

  it("takes a typed login with or without its @, and nothing GitHub couldn't name", () => {
    expect(typedLogin(" @octo-cat ")).toBe("octo-cat");
    expect(typedLogin("app/dependabot")).toBe("app/dependabot");
    expect(typedLogin("--author=x")).toBeNull();
    expect(typedLogin("two words")).toBeNull();
    expect(typedLogin("")).toBeNull();
  });

  it("shows the view a list started as while its filters match, whatever state tab is open", () => {
    const bugs: PullRequestView = { id: "bugs", name: "Bug squad", state: "open", query: "", filters: filters({ authors: ["ada", "linus"], labels: ["bug"] }) };
    const views = [...builtInViews, bugs];
    expect(activeView(views, list({ base: "bugs", state: "merged", filters: filters({ authors: ["Linus", "ada"], labels: ["bug"] }) }))).toBe(bugs);
    expect(activeView(views, list({ base: "bugs", filters: { ...bugs.filters, sort: "oldest" } }))).toBeNull();
    // The old tabs are views now: your review requests and your own pull requests.
    expect(activeView(views, list({ base: "bugs", filters: filters({ review: "awaiting_you_or_team" }) }))?.name).toBe("Needs my review");
    expect(activeView(views, list({ base: "builtin-mine", filters: filters({ authors: ["@me"] }) }))?.name).toBe("Mine");
    expect(listOf(bugs)).toEqual({ state: "open", filters: bugs.filters, query: "", base: "bugs" });
  });

  it("suggests a name from what is set, or the state when nothing is", () => {
    expect(suggestedViewName({ state: "open", query: "", filters: filters({ authors: ["ada", "@me"], labels: ["bug"] }) })).toBe("ada, mine · bug");
    expect(suggestedViewName({ state: "merged", query: "", filters: noPullRequestFilters })).toBe("Merged");
    expect(suggestedViewName({ state: "open", query: "", filters: filters({ review: "awaiting_you", assignee: "@me", sort: "oldest" }) })).toBe("Awaiting review from you · Assigned to you · Oldest");
  });

  describe("storage", () => {
    const saved = new Map<string, string>();
    const session = new Map<string, string>();
    const storage = (map: Map<string, string>) => ({
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => map.set(key, value),
      removeItem: (key: string) => map.delete(key),
    });
    beforeEach(() => {
      saved.clear();
      session.clear();
      vi.stubGlobal("localStorage", storage(saved));
      vi.stubGlobal("sessionStorage", storage(session));
    });
    afterEach(() => vi.unstubAllGlobals());

    it("remembers the filters, and starts over from anything it can't read", () => {
      const set = filters({ authors: ["ada"], labels: ["bug"], review: "none", missing: ["milestone"], sort: "oldest" });
      writePullRequestFilters(set);
      expect(readPullRequestFilters()).toEqual(set);
      saved.set("openorc.pull-filters", JSON.stringify({ authors: ["ada", "-x"], review: "none" }));
      expect(readPullRequestFilters()).toEqual(noPullRequestFilters);
      saved.set("openorc.pull-filters", "{");
      expect(readPullRequestFilters()).toEqual(noPullRequestFilters);
    });

    it("keeps your views apart from the built-in ones, and drops a saved view that no longer makes sense", () => {
      const view: PullRequestView = { id: "v1", name: "Frontend bugs", state: "merged", query: "", filters: filters({ authors: ["ada", "linus"], labels: ["bug"] }) };
      writePullRequestViews([...builtInViews, view]);
      expect(readPullRequestViews()).toEqual([view]);
      saved.set(
        "openorc.pull-views",
        JSON.stringify([
          { id: "kept", name: "To review", state: "open", filters: { review: "awaiting_you_or_team" } },
          { id: "bad", name: "", state: "open", filters: {} },
          { id: "odd", name: "Odd", state: "nope", filters: {} },
        ]),
      );
      expect(readPullRequestViews()).toEqual([{ id: "kept", name: "To review", state: "open", query: "", filters: filters({ review: "awaiting_you_or_team" }) }]);
    });

    it("starts with the last filters, the default view once there is one, and where it was left when coming back", () => {
      const view: PullRequestView = { id: "v1", name: "Frontend bugs", state: "closed", query: "retry", filters: filters({ authors: ["ada"], labels: ["bug"] }) };
      writePullRequestFilters(filters({ review: "approved" }));
      expect(startingListState()).toEqual(list({ filters: filters({ review: "approved" }) }));
      writePullRequestViews([view]);
      writeDefaultViewId("v1");
      expect(readDefaultViewId()).toBe("v1");
      expect(startingListState()).toEqual(list({ state: "closed", query: "retry", filters: view.filters, base: "v1" }));
      writeDefaultViewId("builtin-review");
      expect(startingListState()).toMatchObject({ base: "builtin-review", filters: filters({ review: "awaiting_you_or_team" }) });
      rememberListState(list({ state: "any", filters: filters({ sort: "oldest" }), base: "builtin-mine" }));
      expect(startingListState()).toEqual(list({ state: "any", filters: filters({ sort: "oldest" }), base: "builtin-mine" }));
      // A default view deleted since falls back to the last filters.
      session.clear();
      writeDefaultViewId("gone");
      expect(startingListState()).toMatchObject({ state: "open", base: "builtin-all" });
      writeDefaultViewId(null);
      expect(readDefaultViewId()).toBeNull();
    });
  });
});
