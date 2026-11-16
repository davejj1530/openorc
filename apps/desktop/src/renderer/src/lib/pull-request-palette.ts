import { GitHubLogin, PULL_REQUEST_AUTHOR_LIMIT, PULL_REQUEST_LABEL_LIMIT, SearchName, type PullRequestChoice, type PullRequestSummary } from "@openorc/protocol";
import { authorChoices, isMissing, labelChoices, reviewFilterOptions, typedLogin, withMissing, type PullRequestFilters } from "./pull-requests";

/** What the list asks for: its filters and the words searched for in titles and branches. */
export interface PaletteTarget {
  filters: PullRequestFilters;
  query: string;
}

/** How a palette row marks what it adds: a person's face, a label's color, or nothing. */
export type PaletteMark = { kind: "person"; login: string } | { kind: "dot"; color: string | null } | { kind: "none" };

/** One row of the filter palette: what it adds to the list, said as facet and value. */
export interface PaletteItem {
  key: string;
  facet: string;
  text: string;
  detail?: string;
  mark: PaletteMark;
  apply: (target: PaletteTarget) => PaletteTarget;
}

export interface PaletteGroup {
  label: string;
  items: PaletteItem[];
  /** How many more rows match than the group shows. */
  more: number;
}

/** Everything the palette can offer, read from the repositories in view and the pull requests on the page. */
export interface PaletteSources {
  pulls: readonly PullRequestSummary[];
  labels: readonly PullRequestChoice[];
  assignees: readonly PullRequestChoice[];
  milestones: readonly PullRequestChoice[];
  projects: readonly PullRequestChoice[];
}

/** You, as a filter names you. */
export const ME = "@me";

/** A person as the list says them: you, or their login. */
export const personName = (login: string) => (login === ME ? "you" : login);

/** The letter on a person's face: for an app, its own name's rather than the `app/` gh names it with. */
export const personInitial = (login: string) =>
  personName(login)
    .replace(/^app\//, "")[0]!
    .toUpperCase();

/** Whether a person is you: a row for you also answers to "me", as GitHub's @me. */
const isMe = (login: string) => login === ME;

/** Every word typed must appear somewhere in what the row says. A leading @ matches a login without one. */
function matches(item: PaletteItem, input: string): boolean {
  const me = item.mark.kind === "person" && isMe(item.mark.login) ? " me" : "";
  const haystack = `${item.facet} ${item.text} ${item.detail ?? ""}${me}`.toLowerCase();
  return input
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^@/, ""))
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

const withFilters = (patch: (filters: PullRequestFilters) => PullRequestFilters) => (target: PaletteTarget) => ({ ...target, filters: patch(target.filters) });

/** A row's detail, left off when there is none to show. */
const detailOf = (detail: string | undefined) => (detail ? { detail } : {});

/**
 * Everyone a people row can name: you, anyone chosen, with an open pull request or GitHub can assign, then a login typed
 * that none of them has. Typed bare, it is offered only when no known login contains it, so a partial name finds the
 * person rather than offering itself; typed with its @, it is offered after the known logins it is part of, as `@dave`
 * beside `davejj1530`. Only logins a filter can send are offered, and "me" typed means you.
 */
function people(filters: PullRequestFilters, sources: PaletteSources, input: string): string[] {
  const known = [...new Set([...authorChoices(filters.authors, sources.pulls), ...sources.assignees.map((choice) => choice.value)])].filter(
    (login) => !isMe(login) && GitHubLogin.safeParse(login).success,
  );
  const typed = typedLogin(input);
  const wanted = typed?.toLowerCase() ?? "";
  const knownAs = (match: (login: string) => boolean) => known.some((login) => match(login.toLowerCase()));
  const offered = typed && wanted !== "me" && !knownAs((login) => login === wanted) && (input.startsWith("@") || !knownAs((login) => login.includes(wanted)));
  return [ME, ...known, ...(offered ? [typed] : [])];
}

function peopleItems(filters: PullRequestFilters, sources: PaletteSources, input: string): PaletteItem[] {
  const authors = filters.authors.map((author) => author.toLowerCase());
  const authorsFull = filters.authors.length >= PULL_REQUEST_AUTHOR_LIMIT;
  const items: PaletteItem[] = [];
  for (const login of people(filters, sources, input)) {
    if (!authorsFull && !authors.includes(login.toLowerCase()))
      items.push({ key: `author:${login}`, facet: "Author", text: personName(login), mark: { kind: "person", login }, apply: withFilters((f) => ({ ...f, authors: [...f.authors, login] })) });
    // An app can't be assigned, so `assignee:app/…` would always find nothing.
    if (!login.startsWith("app/") && filters.assignee?.toLowerCase() !== login.toLowerCase())
      items.push({
        key: `assignee:${login}`,
        facet: "Assignee",
        text: personName(login),
        mark: { kind: "person", login },
        apply: withFilters((f) => ({ ...withMissing(f, "assignee", false), assignee: login })),
      });
  }
  if (!isMissing(filters, "assignee")) items.push({ key: "no:assignee", facet: "Assignee", text: "nobody", mark: { kind: "none" }, apply: withFilters((f) => withMissing(f, "assignee", true)) });
  return items;
}

function labelItems(filters: PullRequestFilters, sources: PaletteSources): PaletteItem[] {
  const colors = new Map([
    ...sources.pulls.flatMap((pull) => pull.labels).map((label) => [label.name.toLowerCase(), label.color] as const),
    ...sources.labels.map((choice) => [choice.value.toLowerCase(), choice.color ?? ""] as const),
  ]);
  const details = new Map(sources.labels.map((choice) => [choice.value.toLowerCase(), choice.detail]));
  const picked = filters.labels.map((label) => label.toLowerCase());
  const items: PaletteItem[] =
    filters.labels.length >= PULL_REQUEST_LABEL_LIMIT
      ? []
      : labelChoices([], sources.labels, sources.pulls)
          .filter((name) => !picked.includes(name.toLowerCase()) && SearchName.safeParse(name).success)
          .map((name) => ({
            key: `label:${name}`,
            facet: "Label",
            text: name,
            ...detailOf(details.get(name.toLowerCase())),
            mark: { kind: "dot", color: colors.get(name.toLowerCase()) || null },
            apply: withFilters((f) => ({ ...withMissing(f, "label", false), labels: [...f.labels, name] })),
          }));
  if (!isMissing(filters, "label"))
    items.push({ key: "no:label", facet: "Label", text: "none", detail: "Unlabeled", mark: { kind: "dot", color: null }, apply: withFilters((f) => withMissing(f, "label", true)) });
  return items;
}

function reviewItems(filters: PullRequestFilters): PaletteItem[] {
  return reviewFilterOptions
    .filter((option) => option.value !== filters.review)
    .map((option) => ({ key: `review:${option.value}`, facet: "Review", text: option.label, mark: { kind: "none" }, apply: withFilters((f) => ({ ...f, review: option.value })) }));
}

function milestoneItems(filters: PullRequestFilters, sources: PaletteSources): PaletteItem[] {
  const items: PaletteItem[] = sources.milestones
    .filter((choice) => choice.value !== filters.milestone)
    .map((choice) => ({
      key: `milestone:${choice.value}`,
      facet: "Milestone",
      text: choice.name,
      ...detailOf(choice.detail),
      mark: { kind: "none" },
      apply: withFilters((f) => ({ ...withMissing(f, "milestone", false), milestone: choice.value })),
    }));
  if (!isMissing(filters, "milestone")) items.push({ key: "no:milestone", facet: "Milestone", text: "none", mark: { kind: "none" }, apply: withFilters((f) => withMissing(f, "milestone", true)) });
  return items;
}

function projectItems(filters: PullRequestFilters, sources: PaletteSources): PaletteItem[] {
  return sources.projects
    .filter((choice) => choice.value !== filters.project)
    .map((choice) => ({
      key: `project:${choice.value}`,
      facet: "Project",
      text: choice.name,
      ...detailOf(choice.detail),
      mark: { kind: "none" },
      apply: withFilters((f) => ({ ...f, project: choice.value })),
    }));
}

/** Rows each group shows before anything is typed, so the palette opens as a short menu rather than every choice. */
const RESTING = 5;
const TYPED = 8;
/** Rows a group adds each time it is asked for more. */
export const MORE_ROWS = 10;

/**
 * The filter palette's rows for what was typed, grouped as GitHub's filters are: searching titles and branches first,
 * then people (as author or assignee), labels, reviews, milestones and projects. A row for something already applied
 * isn't offered again, and "none" rows ask for what is missing. `asked` counts, by group label, the times a group was
 * asked for more; each time it shows `MORE_ROWS` further rows.
 */
export function paletteGroups(target: PaletteTarget, sources: PaletteSources, input: string, asked: Readonly<Record<string, number>> = {}): PaletteGroup[] {
  const typed = input.trim();
  const { filters } = target;
  const groups = [
    { label: "People", items: peopleItems(filters, sources, typed) },
    { label: "Labels", items: labelItems(filters, sources) },
    { label: "Reviews", items: reviewItems(filters) },
    { label: "Milestones", items: milestoneItems(filters, sources) },
    { label: "Projects", items: projectItems(filters, sources) },
  ];
  const shown = groups
    .map(({ label, items }) => {
      const matching = typed ? items.filter((item) => matches(item, typed)) : items;
      const limit = (typed ? TYPED : RESTING) + (asked[label] ?? 0) * MORE_ROWS;
      return { label, items: matching.slice(0, limit), more: Math.max(0, matching.length - limit) };
    })
    .filter((group) => group.items.length > 0);
  if (!typed) return shown;
  const search: PaletteItem = {
    key: `search:${typed}`,
    facet: "Search",
    text: typed,
    detail: "in titles, numbers, authors and branches",
    mark: { kind: "none" },
    apply: (current) => ({ ...current, query: typed }),
  };
  return [{ label: "Search", items: [search], more: 0 }, ...shown];
}

/** One filter the list is narrowed by, as the row under the tabs shows it, with the way to take it off. */
export interface FilterToken {
  key: string;
  facet: string;
  text: string;
  people: string[];
  labels: string[];
  remove: (target: PaletteTarget) => PaletteTarget;
}

const namesOf = (names: readonly string[]) => names.map(personName).join(", ");

/**
 * The filters set, in the order the palette adds them, each with its remover. Authors and labels are one token each,
 * as their filter reads: any of these people, all of these labels.
 */
export function filterTokens(target: PaletteTarget, projectNames: ReadonlyMap<string, string> = new Map()): FilterToken[] {
  const { filters, query } = target;
  const tokens: FilterToken[] = [];
  const token = (key: string, facet: string, text: string, remove: (filters: PullRequestFilters) => PullRequestFilters, extra: Partial<FilterToken> = {}) =>
    tokens.push({ key, facet, text, people: [], labels: [], remove: withFilters(remove), ...extra });
  if (filters.authors.length) token("authors", "Author", namesOf(filters.authors), (f) => ({ ...f, authors: [] }), { people: filters.authors });
  if (filters.labels.length) token("labels", "Label", filters.labels.join(", "), (f) => ({ ...f, labels: [] }), { labels: filters.labels });
  if (isMissing(filters, "label")) token("no-label", "Label", "none", (f) => withMissing(f, "label", false));
  if (filters.assignee) token("assignee", "Assignee", personName(filters.assignee), (f) => ({ ...f, assignee: null }), { people: [filters.assignee] });
  if (isMissing(filters, "assignee")) token("no-assignee", "Assignee", "nobody", (f) => withMissing(f, "assignee", false));
  if (filters.review) token("review", "Review", reviewFilterOptions.find((option) => option.value === filters.review)!.label, (f) => ({ ...f, review: null }));
  if (filters.milestone) token("milestone", "Milestone", filters.milestone, (f) => ({ ...f, milestone: null }));
  if (isMissing(filters, "milestone")) token("no-milestone", "Milestone", "none", (f) => withMissing(f, "milestone", false));
  if (filters.project) token("project", "Project", projectNames.get(filters.project) ?? filters.project, (f) => ({ ...f, project: null }));
  if (query.trim()) tokens.push({ key: "query", facet: "Search", text: query.trim(), people: [], labels: [], remove: (current) => ({ ...current, query: "" }) });
  return tokens;
}
