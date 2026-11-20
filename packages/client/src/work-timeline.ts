import { samePath } from "./search-results.js";
import { basename, type WorkChip } from "./work-chips.js";
import type { ObjectState, WorkObject } from "./work-objects.js";

/**
 * A turn's work laid out in time, for the detail view: what it changed and what it proved, as steps along one line.
 * Each file it edited has a lane of its own, which leaves the line just before its first edit and is carried to the
 * end. The reading and searching on the way stay in the summary.
 */
export type StepMark = "search" | "read" | "edit" | "test" | "run" | "publish" | "other";

export interface TimelineStep {
  id: string;
  object: WorkObject;
  /** The file or folder of a read; otherwise the object's own chip, which a branch has none of. */
  chip: WorkChip | null;
  mark: StepMark;
  state: ObjectState;
  /** The lane it sits on: 0 is the turn's own line. */
  lane: number;
}

export interface TimelineLane {
  path: string;
  name: string;
  /** The step it branches from: the one before its first edit. -1 is the start. */
  from: number;
  /** Its steps, in order. */
  steps: number[];
  /** Its first edit, when the turn changed it. */
  edited: number | null;
}

export interface Timeline {
  steps: TimelineStep[];
  /** The files with a lane; `steps[n].lane - 1` indexes it. */
  lanes: TimelineLane[];
}

/** Files that get a lane; the rest stay on the turn's line. */
const LANES = 6;

const marks: Record<WorkObject["kind"], StepMark> = { read: "read", search: "search", edit: "edit", tests: "test", command: "run", git: "publish", web: "search", fetch: "read", tool: "other" };

interface Draft {
  step: Omit<TimelineStep, "lane">;
  path: string | null;
}

function drafts(objects: WorkObject[]): Draft[] {
  return objects.flatMap((object): Draft[] => {
    if (object.kind === "read")
      return object.rows.map((row) => ({ step: { id: `${object.id}:${row.key}`, object, chip: row, mark: "read", state: object.state }, path: row.kind === "file" ? (row.path ?? null) : null }));
    const chip = object.kind === "git" ? null : object.chip;
    return [{ step: { id: object.id, object, chip, mark: marks[object.kind], state: object.state }, path: object.kind === "edit" ? (chip?.path ?? null) : null }];
  });
}

/** The files worth a lane: the edited ones first, then the most visited, at most six, in the order they appeared. */
function laneFiles(steps: Draft[]): string[] {
  const files = new Map<string, { visits: number; edited: boolean; first: number }>();
  steps.forEach(({ step, path }, index) => {
    if (!path) return;
    const key = [...files.keys()].find((known) => samePath(known, path)) ?? path;
    const file = files.get(key) ?? { visits: 0, edited: false, first: index };
    files.set(key, { visits: file.visits + 1, edited: file.edited || step.mark === "edit", first: file.first });
  });
  return [...files.entries()]
    .sort(([, a], [, b]) => Number(b.edited) - Number(a.edited) || b.visits - a.visits || a.first - b.first)
    .slice(0, LANES)
    .sort(([, a], [, b]) => a.first - b.first)
    .map(([path]) => path);
}

/** A step the timeline draws: an edit, a test run, a branch, and anything that failed or is under way. */
const drawn = ({ step }: Draft) => step.mark === "edit" || step.mark === "test" || step.mark === "publish" || step.state === "failed" || step.state === "running";

/** Edits to one file in a row are one step, the latest of them. */
function gathered(steps: Draft[]): Draft[] {
  return steps.filter((draft, at) => {
    const next = steps[at + 1];
    return !(next && draft.path && next.path && draft.step.mark === "edit" && next.step.mark === "edit" && samePath(draft.path, next.path));
  });
}

export function workTimeline(objects: WorkObject[]): Timeline {
  const all = gathered(drafts(objects).filter(drawn));
  const files = laneFiles(all);
  const laneOf = (path: string | null) => (path ? files.findIndex((file) => samePath(file, path)) + 1 : 0);
  const steps = all.map(({ step, path }) => ({ ...step, lane: laneOf(path) }));
  const lanes = files.map((path, index): TimelineLane => {
    const own = steps.flatMap((step, at) => (step.lane === index + 1 ? [at] : []));
    const edited = own.find((at) => steps[at]!.mark === "edit");
    return { path, name: basename(path), from: own[0]! - 1, steps: own, edited: edited ?? null };
  });
  return { steps, lanes };
}
