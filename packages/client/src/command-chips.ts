import { readCommand, searchTerms, shortPath, type CommandAction, type RunLabel } from "./command-reader.js";
import { basename, joinLabels } from "./run-labels.js";
import type { Block } from "./transcript.js";
import type { CallPart, WorkChip } from "./work-chips.js";

type ToolBlock = Extract<Block, { kind: "tool" }>;
type Chip = Omit<WorkChip, "blocks">;
type CodexAction = { type?: unknown; command?: unknown; name?: unknown; path?: unknown; query?: unknown };
/** An action, and for a read whether Codex resolved its path, which makes the row a link to the file. */
type Action = CommandAction & { resolved?: boolean };

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The folder a file sits in, as its last three names: enough to tell two index.ts apart without a whole path. */
export function folderOf(path: string): string {
  return path.split(/[\\/]/).slice(0, -1).filter(Boolean).slice(-3).join("/");
}

/**
 * Codex reads each command itself; the reader fills in what it leaves out (the lines a `sed` printed, a search's
 * scope) and reads the commands Codex calls unknown. Codex's own paths win for reads, since it resolved them.
 */
function codexActions(actions: CodexAction[]): Action[] {
  return actions.flatMap((action): Action[] => {
    const command = text(action.command);
    const reread = readCommand(command);
    const same = reread.length === 1 && reread[0]!.type === action.type ? reread[0]! : null;
    if (action.type === "read") return [{ type: "read", command, path: text(action.path) || text(action.name), range: same?.type === "read" ? same.range : null, resolved: true }];
    if (action.type === "search")
      return [
        same ?? { type: "search", command, query: text(action.query) ? searchTerms(text(action.query), true) : command, scope: text(action.path) ? `in ${text(action.path)}` : null, countable: false },
      ];
    if (action.type === "listFiles") return [same ?? { type: "listFiles", command, path: text(action.path) || ".", pattern: null }];
    // An unknown command that only printed or waited (`echo ---`) has nothing to add beside the rest.
    return reread;
  });
}

/** Notes Claude Code adds after a command's output, which the command never printed. */
const HARNESS_NOTE = /^(Shell cwd was reset to |\[This command modified \d+ files? you've)/;

/** A finished search's printed lines, or null when it failed in a way that says nothing about matches. */
function searchLines(block: ToolBlock): string[] | null {
  if (!block.done || block.outputOmitted || (block.output != null && typeof block.output !== "string")) return null;
  const output = typeof block.output === "string" ? block.output : "";
  if (output.includes("<persisted-output>")) return null;
  const exit = /^Exit code (\d+)\n?/.exec(output);
  const body = exit ? output.slice(exit[0].length) : output;
  const failed = block.isError || block.status === "error";
  return failed && (body.trim() || (exit && exit[1] !== "1")) ? null : body.split("\n").filter((line) => line.trim() && !HARNESS_NOTE.test(line));
}

/**
 * How many lines a search printed, once it finished. grep and rg exit 1 when nothing matched; any other failure says
 * nothing, and so does a line where the shell or the search complained, such as zsh's "no matches found".
 */
function matchNote(block: ToolBlock): string | undefined {
  const lines = searchLines(block);
  if (!lines || lines.some((line) => /^(\(eval\)|zsh|bash|sh|grep|rg):/.test(line))) return undefined;
  return lines.length ? `${lines.length} ${lines.length === 1 ? "match" : "matches"}` : "no matches";
}

/**
 * What a call's rows say. `intent` is the agent's own words for the call; `alone` is whether this is its only row;
 * `countable` is whether that row is a search whose lines are the call's whole output.
 */
interface RowContext {
  block: ToolBlock;
  command: string;
  intent: string | null;
  alone: boolean;
  countable: boolean;
}

type Looked<Type> = Extract<CommandAction, { type: Type }>;

/** A read Codex resolved links to its file; one read from the command opens the call, which shows the lines it printed. */
function readPart(action: Looked<"read"> & { resolved?: boolean }, { intent }: RowContext): CallPart {
  const chip: Chip = { key: action.path, label: basename(action.path), title: intent ?? action.path, kind: "file", detail: folderOf(action.path), ...(action.resolved ? { path: action.path } : {}) };
  return { section: "Read", chip: action.range ? { ...chip, note: action.range } : chip };
}

function listPart(action: Looked<"listFiles">, { intent }: RowContext): CallPart {
  const label = action.path === "." ? "this folder" : shortPath(action.path);
  const chip: Chip = { key: `${action.path}:${action.pattern ?? ""}`, label, title: intent ?? action.command, kind: "folder" };
  return { section: "Listed", chip: action.pattern ? { ...chip, detail: action.pattern } : chip };
}

/** A search the agent described reads as its words, with what it looked for beside them. */
function searchPart(action: Looked<"search">, { block, command, intent, alone, countable }: RowContext): CallPart {
  const described = alone && intent !== null;
  const note = countable ? matchNote(block) : undefined;
  const detail = described ? action.query : action.scope;
  const chip: Chip = { key: `${action.query}:${action.scope ?? ""}`, label: described ? intent : action.query, title: intent ?? command, kind: "query", ...(described ? { live: intent } : {}) };
  return { section: "Searched", chip: { ...chip, ...(detail ? { detail } : {}), ...(note ? { note } : {}) } };
}

function lookedPart(action: Exclude<Action, { type: "unknown" }>, context: RowContext): CallPart {
  if (action.type === "read") return readPart(action, context);
  return action.type === "listFiles" ? listPart(action, context) : searchPart(action, context);
}

type Run = Extract<CommandAction, { type: "unknown" }>;

/**
 * The plain words for a call's runs, joined: "Run the tests and the typecheck". A step that only prepares, such as
 * the `mkdir` before a build, names the row only when nothing else ran.
 */
function runLabel(runs: Run[]): (RunLabel & { steps: string[] }) | null {
  const main = runs.some((run) => !run.preparation) ? runs.filter((run) => !run.preparation) : runs;
  const labels = main.flatMap((run) => (run.run ? [run.run] : [])).filter((run, index, all) => all.findIndex((other) => other.label === run.label) === index);
  const [first] = labels;
  if (!first) return null;
  if (labels.length === 1) return { ...first, steps: [first.done] };
  const steps = labels.map((label) => label.done);
  return { label: joinLabels(labels.map((label) => label.label)), live: joinLabels(labels.map((label) => label.live)), done: joinLabels(steps), steps };
}

/** The call's one Ran row: the agent's words, a plain label for the commands people know, or the command as written. */
function runPart(runs: Run[], { block, command, intent }: RowContext): CallPart {
  if (intent) return { section: "Ran", chip: { key: `intent:${block.id}`, label: intent, title: command || intent, kind: "intent" } };
  const run = runLabel(runs);
  if (run) return { section: "Ran", chip: { key: command, label: run.label, live: run.live, done: run.steps, title: command, kind: "intent", ...(run.detail ? { detail: run.detail } : {}) } };
  const shown = runs.find((step) => !step.preparation) ?? runs[0];
  return { section: "Ran", chip: { key: command, label: shown?.command || command.split("\n")[0]!.trim(), title: command, kind: "command" } };
}

/**
 * A shell call as rows of what it did: each file it read, search it ran and folder it listed gets its own row, and
 * everything else shares one Ran row. A call with nothing to show still gets that row.
 */
export function commandParts(block: ToolBlock, command: string, intent: string | null): CallPart[] {
  const listed = (block.input as { commandActions?: unknown } | null)?.commandActions;
  const codex = Array.isArray(listed) ? listed.filter((action): action is CodexAction => typeof action === "object" && action !== null) : [];
  const actions: Action[] = codex.length ? codexActions(codex) : readCommand(command);
  const runs = actions.filter((action) => action.type === "unknown");
  const looked = actions.filter((action) => action.type !== "unknown");
  // Codex splits a command into actions read one by one; whether a search's lines can be counted is the whole call's.
  const [whole, ...more] = codex.length ? readCommand(command) : actions;
  const countable = !more.length && whole?.type === "search" && whole.countable;
  const context: RowContext = { block, command, intent, alone: looked.length === 1 && !runs.length, countable };
  const parts: CallPart[] = [];
  for (const action of actions) {
    if (action.type !== "unknown") parts.push(lookedPart(action, context));
    else if (action === runs[0]) parts.push(runPart(runs, context));
  }
  return parts.length ? parts : [runPart([], context)];
}
