import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Menu } from "@base-ui/react/menu";
import type { Project, PullRequestChoice, PullRequestChoiceKind, PullRequestSort, PullRequestSummary } from "@openorc/protocol";
import { ArrowDownUp, Check, ChevronDown, Funnel, Search, X } from "./icons";
import { menuItem, menuPopup, menuSeparator } from "./menu";
import { CoversPreview } from "../lib/browser-preview";
import { cn } from "../lib/cn";
import { useRpcs } from "../lib/client";
import { filterTokens, MORE_ROWS, paletteGroups, personName, type PaletteGroup, type PaletteItem, type PaletteMark, type PaletteTarget } from "../lib/pull-request-palette";
import { mergedChoices, reactionSortOptions, sortLabel, sortOptions } from "../lib/pull-requests";
import { floatingGround } from "../lib/use-anchor-ground";

/** A person's face: their initial on the strong fill. */
export function PersonFace({ login, size = 18 }: { login: string; size?: number }) {
  return (
    <span aria-hidden="true" className="pull-face" style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}>
      {personName(login)[0]!.toUpperCase()}
    </span>
  );
}

/** Faces side by side, each tucked under the last. */
export function PeopleStack({ logins, size = 18 }: { logins: readonly string[]; size?: number }) {
  return (
    <span className="pull-faces">
      {logins.map((login) => (
        <PersonFace key={login} login={login} size={size} />
      ))}
    </span>
  );
}

/** A label's GitHub color as a dot, or the quiet ink when it has none. */
export function LabelDot({ color, className = "pull-palette-dot" }: { color: string | null | undefined; className?: string }) {
  return <span aria-hidden="true" className={className} style={color ? { backgroundColor: `#${color}` } : undefined} />;
}

function Mark({ mark }: { mark: PaletteMark }) {
  if (mark.kind === "person") return <PersonFace login={mark.login} size={20} />;
  if (mark.kind === "dot") return <LabelDot color={mark.color} />;
  return <span aria-hidden="true" className="pull-palette-blank" />;
}

const firstError = (reads: { error: Error | null }[]) => reads.find((read) => read.error)?.error ?? null;

/** One `pulls.choices` read per project, for one filter's list. */
const choiceReads = (projects: readonly Project[], kind: PullRequestChoiceKind) => projects.map((project) => ({ projectId: project.id, kind }));

/** One filter's choices from every project's read, each value once. */
const mergedReads = (reads: readonly { data?: PullRequestChoice[] | undefined }[]) => mergedChoices(reads.map((read) => read.data ?? []));

/**
 * A repository's labels, assignees, milestones and projects change seldom, and each read is a gh process per project,
 * so the palette reads them again only after a while rather than every time it opens.
 */
const CHOICES_READ = { staleTime: 10 * 60_000 } as const;

/**
 * A repository's projects. Reading them needs a gh scope most sign-ins lack, and asking again won't grant it, so a
 * failure isn't retried; it stands until the page is opened again.
 */
const PROJECTS_READ = { ...CHOICES_READ, retry: false } as const;

/** What the palette offers, read the first time it opens: each repository's lists and everyone with an open pull request. */
function usePaletteSources(projects: Project[], enabled: boolean, pulls: readonly PullRequestSummary[]) {
  const labels = useRpcs("pulls.choices", choiceReads(projects, "labels"), { enabled, ...CHOICES_READ });
  const assignees = useRpcs("pulls.choices", choiceReads(projects, "assignees"), { enabled, ...CHOICES_READ });
  const milestones = useRpcs("pulls.choices", choiceReads(projects, "milestones"), { enabled, ...CHOICES_READ });
  const projectLists = useRpcs("pulls.choices", choiceReads(projects, "projects"), { enabled, ...PROJECTS_READ });
  const everyone = useRpcs(
    "pulls.list",
    projects.map((project) => ({ projectId: project.id, state: "open" as const })),
    { enabled },
  );
  const reads = [...labels, ...assignees, ...milestones, ...everyone];
  const loading = [...reads, ...projectLists].some((read) => read.isFetching);
  let status: string | null = null;
  if (enabled) status = loading ? "Loading people, labels and milestones…" : (firstError(reads)?.message ?? null);
  return {
    sources: {
      pulls: [...pulls, ...everyone.flatMap((read) => read.data ?? [])],
      labels: mergedReads(labels),
      assignees: mergedReads(assignees),
      milestones: mergedReads(milestones),
      projects: mergedReads(projectLists),
    },
    status,
    // Projects need a scope gh may not have; that says so in the palette without hiding everything else.
    projectsNote: enabled ? (firstError(projectLists)?.message ?? null) : null,
  };
}

const FOLDED_KEY = "openorc.pull-palette-folded";

/** The palette groups folded away last time, so they stay out of the way. */
function readFolded(): ReadonlySet<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((label): label is string => typeof label === "string") : []);
  } catch {
    return new Set();
  }
}

function writeFolded(folded: ReadonlySet<string>): void {
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded]));
  } catch {
    // Folding then lasts for this session only.
  }
}

/** The last row of a group that holds more than it shows: picking it shows the next ones. */
interface MoreRow {
  key: string;
  group: string;
  /** How many rows picking it adds. */
  next: number;
}

type PaletteRow = PaletteItem | MoreRow;

const isMoreRow = (row: PaletteRow): row is MoreRow => "next" in row;

/**
 * A palette group as the list draws it: folded away it keeps its header and says how many rows it holds; open, a group
 * holding more than it shows ends with the row that shows more.
 */
interface ShownGroup {
  label: string;
  items: PaletteRow[];
  folded: boolean;
  hidden: number;
}

function shownGroup(group: PaletteGroup, folded: boolean): ShownGroup {
  if (folded) return { label: group.label, items: [], folded, hidden: group.items.length + group.more };
  const more: MoreRow[] = group.more > 0 ? [{ key: `more:${group.label}`, group: group.label, next: Math.min(group.more, MORE_ROWS) }] : [];
  return { label: group.label, items: [...group.items, ...more], folded, hidden: 0 };
}

/** The groups with the ones folded away emptied, and the way to fold or unfold one, remembered for next time. */
function useFoldedGroups(groups: PaletteGroup[]): { groups: ShownGroup[]; fold: (label: string) => void } {
  const [folded, setFolded] = useState(readFolded);
  const fold = (label: string) => {
    const next = new Set(folded);
    if (!next.delete(label)) next.add(label);
    setFolded(next);
    writeFolded(next);
  };
  return { groups: groups.map((group) => shownGroup(group, folded.has(group.label))), fold };
}

function PaletteRowContent({ row }: { row: PaletteRow }) {
  if (isMoreRow(row))
    return (
      <>
        <span aria-hidden="true" className="pull-palette-blank pull-palette-more">
          <ChevronDown size={14} />
        </span>
        <span className="min-w-0 flex-1 truncate text-ink-3">Show {row.next} more</span>
      </>
    );
  return (
    <>
      <Mark mark={row.mark} />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-ink-3">{row.facet}</span> <span className="text-ink">{row.text}</span>
      </span>
      {row.detail ? <span className="max-w-40 shrink-0 truncate text-sm text-ink-4">{row.detail}</span> : null}
    </>
  );
}

/** What a row says to assistive tech and Base UI: its filter, or which group it shows more of. */
const rowLabel = (row: PaletteRow) => (isMoreRow(row) ? `Show ${row.next} more ${row.group.toLowerCase()}` : `${row.facet} ${row.text}`);

/** One group's header, which folds it, and its rows. */
function PaletteGroupRows({ group, onFold }: { group: ShownGroup; onFold: (label: string) => void }) {
  return (
    <Combobox.Group items={group.items} className="pull-palette-group">
      {/* The label names the group for assistive tech, which Base UI keeps it hidden from; the button beside it folds. */}
      <Combobox.GroupLabel className="sr-only">{group.label}</Combobox.GroupLabel>
      <div className="pull-palette-label">
        <button
          type="button"
          className="pull-palette-fold"
          aria-expanded={!group.folded}
          aria-label={group.folded ? `${group.label}, ${group.hidden} folded away` : group.label}
          // Keeps the field focused, so typing carries on after a fold.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onFold(group.label)}
        >
          <ChevronDown size={12} className={cn("pull-palette-chevron", group.folded && "pull-palette-chevron-folded")} />
          {group.label}
          {group.folded ? <span className="pull-palette-hidden">{group.hidden}</span> : null}
        </button>
      </div>
      <Combobox.Collection>
        {(row: PaletteRow) => (
          <Combobox.Item key={row.key} value={row} aria-label={isMoreRow(row) ? rowLabel(row) : undefined} className={cn(menuItem, "pull-palette-item")}>
            <PaletteRowContent row={row} />
          </Combobox.Item>
        )}
      </Combobox.Collection>
    </Combobox.Group>
  );
}

const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** "/" opens the palette from anywhere on the page but a field, as on GitHub, unless there is nothing to open. */
function useSlash(open: (() => void) | null) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || editable(event.target)) return;
      event.preventDefault();
      open();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
}

/**
 * The filter palette: one field that finds every filter GitHub's list has, by person (as author or assignee), label,
 * review, milestone or project, and searches titles with whatever else was typed. Rows add as they're picked and the
 * palette stays open for the next; Backspace in an empty field takes the last filter off.
 */
export function PullRequestPalette({
  projects,
  target,
  onChange,
  pulls,
  enabled,
}: {
  projects: Project[];
  target: PaletteTarget;
  onChange: (target: PaletteTarget) => void;
  pulls: readonly PullRequestSummary[];
  enabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [wanted, setWanted] = useState(false);
  const [input, setInput] = useState("");
  // The times each group was asked for more since the palette opened.
  const [asked, setAsked] = useState<Record<string, number>>({});
  const { sources, status, projectsNote } = usePaletteSources(projects, enabled && wanted, pulls);
  const { groups, fold } = useFoldedGroups(paletteGroups(target, sources, input, asked));
  const openPalette = useCallback(() => {
    setWanted(true);
    setOpen(true);
  }, []);
  // A disabled palette can't be dismissed, so "/" leaves it shut.
  useSlash(enabled ? openPalette : null);
  const removeLast = () => {
    const last = filterTokens(target).at(-1);
    if (last) onChange(last.remove(target));
  };
  return (
    <Combobox.Root
      multiple
      items={groups}
      // The groups exactly as drawn: the palette filters them itself, and a folded group, empty, keeps its header.
      filteredItems={groups}
      value={[]}
      filter={null}
      itemToStringLabel={rowLabel}
      onValueChange={(picked: PaletteRow[], details) => {
        const row = picked.at(-1);
        if (!row) return;
        if (!isMoreRow(row)) return onChange(row.apply(target));
        // Base UI clears what was typed when a row is picked; showing more keeps the search going.
        details.cancel();
        setAsked({ ...asked, [row.group]: (asked[row.group] ?? 0) + 1 });
      }}
      inputValue={input}
      onInputValueChange={setInput}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setWanted(true);
      }}
      onOpenChangeComplete={(next) => {
        if (next) return;
        setInput("");
        setAsked({});
      }}
      disabled={!enabled}
      autoHighlight
    >
      <Combobox.Trigger className="pull-tool" aria-label="Filter pull requests">
        <Funnel size={14} />
        Filter
      </Combobox.Trigger>
      <Combobox.Portal>
        <CoversPreview />
        <Combobox.Positioner sideOffset={8} align="end" className="z-40" collisionPadding={8}>
          <Combobox.Popup ref={floatingGround} aria-label="Filter pull requests" className={cn(menuPopup, "pull-palette")}>
            <label className="pull-palette-field">
              <Search size={16} className="shrink-0 text-ink-3" />
              <Combobox.Input
                aria-label="Filter by person, label, review, milestone or project"
                placeholder="Filter by person, label, review, milestone…"
                aria-description="Enter adds the highlighted filter. Backspace in the empty field takes the last filter off."
                className="native-field"
                onKeyDown={(event) => {
                  if (event.key === "Backspace" && !input) removeLast();
                }}
              />
            </label>
            <Combobox.Empty>
              <p className="menu-empty">{status ?? (groups.some((group) => group.hidden) ? "What matches is in a folded group." : `Nothing matches “${input.trim()}”.`)}</p>
            </Combobox.Empty>
            <Combobox.List className="pull-palette-list">{(group: ShownGroup) => <PaletteGroupRows key={group.label} group={group} onFold={fold} />}</Combobox.List>
            {groups.length > 0 && status ? <p className="menu-empty">{status}</p> : null}
            {projectsNote ? <p className="menu-empty">{projectsNote}</p> : null}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

/** The filters set, one quiet token each, under the state tabs. Each comes off with its ×. */
export function PullRequestTokens({
  target,
  onChange,
  labelColors,
  projects,
}: {
  target: PaletteTarget;
  onChange: (target: PaletteTarget) => void;
  labelColors: ReadonlyMap<string, string>;
  projects: Project[];
}) {
  const projectLists = useRpcs("pulls.choices", choiceReads(projects, "projects"), { enabled: Boolean(target.filters.project), ...PROJECTS_READ });
  const labelLists = useRpcs("pulls.choices", choiceReads(projects, "labels"), { enabled: target.filters.labels.length > 0, ...CHOICES_READ });
  const projectNames = new Map(mergedReads(projectLists).map((choice) => [choice.value, choice.name]));
  // A label no pull request on the page carries still has its repository's color.
  const colors = new Map([...mergedReads(labelLists).map((choice) => [choice.value.toLowerCase(), choice.color ?? ""] as const), ...labelColors]);
  const tokens = filterTokens(target, projectNames);
  if (tokens.length === 0) return null;
  return (
    <div className="pull-tokens" role="group" aria-label="Filters">
      {tokens.map((token) => (
        <span key={token.key} className="pull-token">
          <span className="text-ink-3">{token.facet}</span>
          {token.people.length ? <PeopleStack logins={token.people} size={16} /> : null}
          {token.labels.map((label) => (
            <LabelDot key={label} color={colors.get(label.toLowerCase())} />
          ))}
          <span className="min-w-0 truncate text-ink">{token.text}</span>
          <button type="button" className="pull-token-x" aria-label={`Remove ${token.facet.toLowerCase()} filter ${token.text}`} onClick={() => onChange(token.remove(target))}>
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  );
}

function SortItem({ value, chosen, children }: { value: string; chosen: boolean; children: ReactNode }) {
  return (
    <Menu.RadioItem value={value} className={menuItem} closeOnClick>
      <Check size={13} className={cn("shrink-0 text-transparent", chosen && "text-ink")} />
      <span className="flex-1">{children}</span>
    </Menu.RadioItem>
  );
}

/** GitHub's Sort menu: the orders by name, then the reactions as a row of emoji. */
export function PullRequestSortMenu({ value, onChange }: { value: PullRequestSort; onChange: (value: PullRequestSort) => void }) {
  const chosen = sortLabel(value);
  const pick = (next: string) => {
    const sort = [...sortOptions, ...reactionSortOptions].find((option) => option.value === next);
    if (sort) onChange(sort.value);
  };
  return (
    <Menu.Root>
      <Menu.Trigger className={cn("pull-tool", chosen && "pull-tool-set")} aria-label={chosen ? `Sort: ${chosen}` : "Sort: newest"}>
        <ArrowDownUp size={14} />
        {chosen ?? "Newest"}
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={8} align="end" className="z-40" collisionPadding={8}>
          <Menu.Popup ref={floatingGround} className={menuPopup}>
            <Menu.RadioGroup aria-label="Sort by" value={value} onValueChange={pick}>
              {sortOptions.map((option) => (
                <SortItem key={option.value} value={option.value} chosen={value === option.value}>
                  {option.label}
                </SortItem>
              ))}
              <Menu.Separator className={menuSeparator} />
              <Menu.Group aria-label="Most reactions">
                <Menu.GroupLabel className="menu-empty py-1">Most reactions</Menu.GroupLabel>
                <div className="page-filter-reactions">
                  {reactionSortOptions.map((option) => (
                    <Menu.RadioItem
                      key={option.value}
                      value={option.value}
                      closeOnClick
                      aria-label={option.label}
                      className={cn("page-filter-reaction", value === option.value && "page-filter-reaction-chosen")}
                    >
                      <span aria-hidden="true">{option.emoji}</span>
                    </Menu.RadioItem>
                  ))}
                </div>
              </Menu.Group>
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
