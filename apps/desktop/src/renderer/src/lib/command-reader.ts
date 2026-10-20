import { pipeline, shellSteps, unwrapShell, type PipedCommand } from "./shell";
import { basename, commandLabel, isPreparation, names, said, unwrapWords, type RunLabel } from "./run-labels";
import { joinPath } from "./tool-view";
import { parseArgs } from "./command-args";
import { countable, globsOf, inverted, matchesAll, recursive, RG_VALUED, scopeOf, SEARCHERS, searchArgs, searchQuery, searchScope, shortGlob, type SearchArgs } from "./command-search";

export { searchTerms, shortPath } from "./command-search";
export type { RunLabel } from "./run-labels";

/**
 * A shell command read for what it did, one action per step that matters, in the shape Codex gives its own
 * commandActions: a `sed -n 70,100p` reads a file, a `grep … | head` searches, an `ls` lists, and anything else runs.
 * Steps that only move, print or wait (`cd`, `echo`, `sleep`) are left out. In a pipeline the first command
 * decides, except that a file piped into `grep` is a search in that file, and a listing piped into one keeps the
 * names it matched.
 */
export type CommandAction =
  | { type: "read"; command: string; path: string; range: string | null }
  | { type: "search"; command: string; query: string; scope: string | null; countable: boolean }
  | { type: "listFiles"; command: string; path: string; pattern: string | null }
  | { type: "unknown"; command: string; run: RunLabel | null; preparation: boolean };

type SearchAction = Extract<CommandAction, { type: "search" }>;

/** What the reader knows about one command of a step. */
interface Command {
  /** The program as written, which may be a path: `./scripts/release.sh`. */
  program: string;
  name: string;
  args: string[];
  output: PipedCommand["output"];
  /** The commands after it in the pipeline. */
  rest: PipedCommand[];
  /** What a heredoc fed the step. */
  input: string | null;
  /** The step as written, for the title and for a command with no label. */
  text: string;
}

const SKIPPED = new Set([
  ...["cd", "pushd", "popd", "echo", "printf", "sleep", "true", "false", ":", "set", "export", "unset", "source", "."],
  ...["wait", "clear", "pwd", "date", "exit", "return", "trap", "shopt", "alias", "local", "declare", "readonly"],
  ...["test", "[", "[[", "ulimit", "umask", "hash"],
]);
/** Skipped steps that still print, so the call's output is not only what its search found. */
const PRINTERS = /^(echo|printf|pwd|date|pushd|popd|cat|command|type)$/;

/** The actions a whole command took, in order. */
export function readCommand(command: string): CommandAction[] {
  const reader = new ChainReader();
  const actions = reader.read(unwrapShell(command.trim()));
  // A search's lines are only its matches when it is the one step that printed anything.
  if (actions.length === 1 && !reader.chatty) return actions;
  return actions.map((action) => (action.type === "search" ? { ...action, countable: false } : action));
}

const inner = (text: string) => text.slice(1, -1).replace(/;\s*$/, "");

/** A path without its `.` and `..` steps, as far as they can be resolved: `apps/../README.md` is README.md. */
function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === ".") continue;
    if (part === ".." && parts.length && !/^(\.\.?|~|)$/.test(parts.at(-1)!)) parts.pop();
    else parts.push(part);
  }
  return parts.join("/") || ".";
}

class ChainReader {
  /** Where the steps run, once a `cd` has said; null when they run where the call started. */
  private folder: string | null = null;
  /** Whether a step that only prints, such as an `echo`, wrote to the call's output. */
  chatty = false;

  read(script: string): CommandAction[] {
    return shellSteps(script).flatMap((step) => this.step(step.text.trim(), step.input));
  }

  private step(text: string, input: string | null): CommandAction[] {
    // A group runs its steps here; a subshell runs them in a copy of the shell, so a `cd` inside stays there.
    if (/^\{.*\}$/s.test(text)) return this.read(inner(text));
    if (/^\(.*\)$/s.test(text)) {
      const folder = this.folder;
      const actions = this.read(inner(text));
      this.folder = folder;
      return actions;
    }
    const [first, ...rest] = pipeline(text);
    const words = unwrapWords(first!.words);
    if (!words.length) return this.captured(first!.words);
    if (words[0] === "cd") return this.move(words[1]);
    return this.command({ program: words[0]!, name: basename(words[0]!), args: words.slice(1), output: first!.output, rest, input, text });
  }

  /** `out=$(npx jest …)` runs what it captures. A plain label for that is kept; what it only looked at prints nothing. */
  private captured(words: string[]): CommandAction[] {
    return words.flatMap((word) => {
      const captured = /^[A-Za-z_]\w*=(?:\$\(([\s\S]*)\)|`([\s\S]*)`)$/.exec(word);
      if (!captured) return [];
      const reader = new ChainReader();
      reader.folder = this.folder;
      return reader.read(captured[1] ?? captured[2] ?? "").filter((action) => action.type === "unknown" && action.run !== null);
    });
  }

  private move(folder: string | undefined): CommandAction[] {
    this.folder = folder && !folder.includes("$") && folder !== "-" ? normalize(joinPath(this.folder, folder)) : null;
    return [];
  }

  private path(path: string): string {
    return normalize(joinPath(this.folder, path));
  }

  private command(command: Command): CommandAction[] {
    if (/^[A-Za-z_]\w*=/.test(command.name)) return [];
    if (SKIPPED.has(command.name) || (command.name === "command" && /^-[vV]$/.test(command.args[0] ?? ""))) return this.feeder(command);
    if (command.name === "cat" && !command.args.some((arg) => !/^-/.test(arg))) return this.feeder(command);
    return this.looked(command) ?? [this.run(command)];
  }

  /** `echo` and a bare heredoc `cat` only print, unless they write a file or feed the next command. */
  private feeder(command: Command): CommandAction[] {
    if (command.output && command.output.path !== "/dev/null" && /^(echo|printf|cat)$/.test(command.name)) return [ran(command, said("Wrote", basename(command.output.path)))];
    const [next, ...rest] = command.rest;
    if (next?.via === "|" && /^(echo|printf|cat)$/.test(command.name)) {
      const words = unwrapWords(next.words);
      return this.command({ ...command, program: words[0] ?? "", name: basename(words[0] ?? ""), args: words.slice(1), output: next.output, rest });
    }
    const named = [command.name, ...command.rest.map((after) => basename(unwrapWords(after.words)[0] ?? ""))];
    if (!command.output && named.some((name) => PRINTERS.test(name))) this.chatty = true;
    return [];
  }

  private looked(command: Command): CommandAction[] | null {
    if (command.name === "git" && command.args[0] === "grep") return this.searched({ ...command, name: "grep", args: command.args.slice(1) });
    const listed = listing(command);
    // A path held in a variable could be anywhere, so its listing or read shows as the command it was.
    if (listed?.some((target) => target.path.includes("$"))) return null;
    if (listed) return this.listed(command, listed);
    if (SEARCHERS.test(command.name)) return this.searched(command);
    const reader = READERS[command.name];
    const target = reader && !command.output ? reader(command.args) : null;
    if (!target?.files.length || target.files.some((file) => file.includes("$"))) return null;
    return this.printed(command, target);
  }

  /**
   * A grep by what it printed. `grep -v` prints the lines that did not match, and an empty pattern matches them
   * all, so on a file either one reads it; `grep -c ""` counts its lines.
   */
  private searched(command: Command): CommandAction[] {
    const parsed = searchArgs(command.name, command.args);
    const files = parsed.operands.filter((path) => !/[*?[{$]/.test(path) && !path.startsWith(":"));
    // An empty pattern prints whatever it was given, which is no search; with no file to name, it ran as written.
    if (matchesAll(parsed) && !files.length) return [this.run(command)];
    if (!(inverted(parsed) || matchesAll(parsed)) || !files.length || recursive(parsed)) return [search(command, parsed)];
    if (parsed.args.flags.has("c") || parsed.args.flags.has("--count")) return [ran(command, said("Counted", `lines in ${names(files)}`))];
    return this.reads(command, files, narrowing(command.rest));
  }

  private reads(command: Command, files: string[], range: string | null): CommandAction[] {
    return files.flatMap(expandBraces).map((file) => ({ type: "read", command: command.text, path: this.path(file), range }));
  }

  /** Each file a read printed, its range narrowed by what it was piped through, or a search when piped into grep. */
  private printed(command: Command, target: ReadTarget): CommandAction[] {
    const [next, ...rest] = command.rest;
    const words = next?.via === "|" ? unwrapWords(next.words) : [];
    const name = basename(words[0] ?? "");
    const files = target.files.flatMap(expandBraces);
    if (SEARCHERS.test(name)) {
      const piped = { ...command, name, args: [...words.slice(1).filter((word) => word !== "-"), ...files], output: next!.output, rest };
      const parsed = searchArgs(name, piped.args);
      // A file filtered through `grep -v` is still that file, read.
      if (!inverted(parsed)) return [search(piped, parsed)];
    }
    return this.reads(command, files, narrowing(command.rest) ?? target.range);
  }

  /** A listing as rows, narrowed by a grep of the names it printed; when xargs hands the files to grep, a search in them. */
  private listed(command: Command, targets: ListTarget[]): CommandAction[] {
    const paths = targets.map((target) => (target.path === "." ? (this.folder ?? ".") : this.path(target.path)));
    // `ls` on files checks they are there; it lists no folder.
    if (command.name === "ls" && targets.every((target) => !target.pattern && FILE.test(target.path))) return [ran(command, said("Checked", names(paths)))];
    const [next, ...rest] = command.rest;
    const piped = next?.via === "|" ? unwrapWords(next.words) : [];
    const handed = basename(piped[0] ?? "") === "xargs" ? xargsCommand(piped.slice(1)) : [];
    if (SEARCHERS.test(basename(handed[0] ?? ""))) {
      const found = search({ ...command, name: basename(handed[0]!), args: handed.slice(1), output: next!.output, rest });
      return [
        {
          ...found,
          scope: scopeOf(
            paths,
            targets.flatMap((target) => (target.pattern ? [target.pattern] : [])),
          ),
        },
      ];
    }
    const filter = SEARCHERS.test(basename(piped[0] ?? "")) ? nameFilter(basename(piped[0]!), piped.slice(1)) : null;
    return targets.map((target, index) => ({ type: "listFiles", command: command.text, path: paths[index]!, pattern: [target.pattern, filter].filter(Boolean).join(", ") || null }));
  }

  private run(command: Command): CommandAction {
    const words = [command.program, ...command.args];
    if (command.name === "sed" && command.args.some((arg) => /^-\w*i/.test(arg))) return ran(command, said("Edited", basename(command.args.at(-1) ?? "")));
    return ran(command, command.output?.path && /^(cat|tee)$/.test(command.name) ? said("Wrote", basename(command.output.path)) : commandLabel(words, command.input));
  }
}

function ran(command: Command, run: RunLabel | null): CommandAction {
  return { type: "unknown", command: command.text.split("\n")[0]!.trim(), run, preparation: isPreparation([command.name, ...command.args]) };
}

/** A search's action: what it looked for, where, and whether its lines can be counted. */
function search(command: Command, parsed: SearchArgs = searchArgs(command.name, command.args)): SearchAction {
  return { type: "search", command: command.text, query: searchQuery(parsed), scope: searchScope(parsed), countable: countable(parsed, command.rest, Boolean(command.output)) };
}

/** A grep over a listing's names, as the names it kept: "names with “test”". */
function nameFilter(name: string, words: string[]): string {
  const parsed = searchArgs(name, words);
  return `names ${inverted(parsed) ? "without" : "with"} ${searchQuery(parsed)}`;
}

/** The command xargs runs, past xargs' own options. */
function xargsCommand(words: string[]): string[] {
  let at = 0;
  while (at < words.length && /^-/.test(words[at]!)) at += /^(-[IJnPLdEsa]|--(replace|max-args|max-procs|delimiter))$/.test(words[at]!) ? 2 : 1;
  return unwrapWords(words.slice(at));
}

/** A name with an extension, so a file rather than a folder: `a.ts`, not `.claude` or `src`. */
const FILE = /[^/.]\.\w{1,6}$/;

/** `src/{a,b}.ts` as the files it names. */
function expandBraces(path: string): string[] {
  const match = /^([^{}]*)\{([^{}]*,[^{}]*)\}(.*)$/.exec(path);
  return match ? match[2]!.split(",").flatMap((name) => expandBraces(`${match[1]}${name}${match[3]}`)) : [path];
}

/** The lines a read was cut to by what it was piped through: `| head -20`, `| sed -n 5,9p`. */
function narrowing(rest: PipedCommand[]): string | null {
  const [next] = rest;
  const words = next?.via === "|" ? unwrapWords(next.words) : [];
  return READERS[basename(words[0] ?? "")]?.(words.slice(1))?.range ?? null;
}

interface ReadTarget {
  files: string[];
  range: string | null;
}

function lines(from: string, to?: string): string {
  if (to === undefined) return `line ${from}`;
  return to === "$" ? `from line ${from}` : `lines ${from}–${to}`;
}

/** What `head` or `tail` with a count prints: "first 20 lines", or from a line on when the count is "+N". */
function countLines(count: string, end: string): string {
  return count.startsWith("+") ? `from line ${count.slice(1)}` : `${end} ${count} line${count === "1" ? "" : "s"}`;
}

/** The last line an awk range prints: its bound, one less for a strict bound, or the end of the file. */
function awkEnd(op: string | undefined, bound: string | undefined): string {
  return bound ? String(Number(bound) - (op === "<" ? 1 : 0)) : "$";
}

/** The lines a `sed -n` script prints: "70,100p", "12p", "1,5p;20,30p". Null for anything less plain. */
function sedRange(script: string): string | null {
  const pieces = script.split(";").map((piece) => /^(\d+)(?:,(\d+|\$))?p$/.exec(piece.trim()));
  if (!pieces.length || pieces.some((piece) => !piece)) return null;
  const ranges = pieces.map((piece) => lines(piece![1]!, piece![2]));
  return [ranges[0], ...ranges.slice(1).map((range) => range!.replace(/^lines? /, ""))].join(", ");
}

/** `head -20`, `head -n 20`, `tail -n +5`: how many lines, from which end. */
function countRange(args: string[], end: "first" | "last"): { files: string[]; range: string | null } {
  const short = args.find((arg) => /^-\d+$/.test(arg))?.slice(1);
  const parsed = parseArgs(
    args.filter((arg) => !/^-\d+$/.test(arg)),
    new Set(["n", "c", "--lines", "--bytes"]),
  );
  const count = short ?? parsed.values.get("n")?.[0] ?? parsed.values.get("--lines")?.[0] ?? (parsed.flags.has("c") || parsed.flags.has("f") || parsed.flags.has("F") ? undefined : "10");
  const range = count === undefined ? null : countLines(count, end);
  return { files: parsed.positional, range };
}

const AWK_RANGE = /^\s*NR\s*(==|>=|>)\s*(\d+)\s*(?:&&\s*NR\s*(<=|<)\s*(\d+))?\s*(?:\{\s*print(?:\s*\$0)?\s*;?\s*\})?\s*$/;

/** Programs that print a file, and what of it. Each says which files it read and which lines; null when it is not a read. */
const READERS: Record<string, (args: string[]) => ReadTarget | null> = {
  cat: (args) => ({ files: args.filter((arg) => !/^-/.test(arg)), range: null }),
  nl: (args) => ({ files: parseArgs(args, new Set(["b", "w", "s", "v", "i", "n"])).positional, range: null }),
  bat: (args) => {
    const parsed = parseArgs(args, new Set(["r", "--line-range", "l", "--language", "--style", "--theme"]));
    const range = (parsed.values.get("r") ?? parsed.values.get("--line-range"))?.[0]?.split(":");
    return { files: parsed.positional, range: range ? lines(range[0]!, range[1] || "$") : null };
  },
  less: (args) => ({ files: args.filter((arg) => !/^[-+]/.test(arg)), range: null }),
  more: (args) => ({ files: args.filter((arg) => !/^[-+]/.test(arg)), range: null }),
  head: (args) => countRange(args, "first"),
  tail: (args) => countRange(args, "last"),
  sed: (args) => {
    const parsed = parseArgs(args, new Set(["e", "f", "i", "E", "--expression", "--file"]));
    if (!parsed.flags.has("n") || parsed.flags.has("i")) return null;
    const scripts = parsed.values.get("e") ?? parsed.values.get("--expression");
    const script = scripts?.join(";") ?? parsed.positional[0] ?? "";
    return { files: scripts ? parsed.positional : parsed.positional.slice(1), range: sedRange(script) };
  },
  awk: (args) => {
    const [script = "", ...files] = args.filter((arg) => !/^-/.test(arg));
    const match = AWK_RANGE.exec(script);
    if (!match) return null;
    const from = match[1] === ">" ? String(Number(match[2]) + 1) : match[2]!;
    const to = match[1] === "==" ? undefined : awkEnd(match[3], match[4]);
    return { files, range: lines(from, to) };
  },
};

interface ListTarget {
  path: string;
  pattern: string | null;
}

const FIND_PATTERN = new Set(["-name", "-iname", "-path", "-ipath", "-regex", "-iregex"]);

/** Programs that list a folder, and the pattern they listed by. */
/** A path with a glob lists its folder by that pattern: `src/*.ts` is src, by *.ts. */
function globTarget(path: string): ListTarget {
  const glob = path.search(/[*?[]/);
  if (glob < 0) return { path: path.replace(/(.)\/+$/, "$1"), pattern: null };
  const slash = path.lastIndexOf("/", glob);
  return { path: slash < 0 ? "." : path.slice(0, slash) || "/", pattern: path.slice(slash + 1) };
}

/** What a command listed: the folders, each with the pattern it listed by. Null when it does not list. */
function listing(command: Command): ListTarget[] | null {
  if (command.name === "git" && command.args[0] === "ls-files") return [trackedFiles(command.args.slice(1))];
  if (command.name === "rg" && command.args.includes("--files")) {
    const args = parseArgs(command.args, RG_VALUED);
    return [{ path: args.positional[0] ?? ".", pattern: globsOf(args).join(", ") || null }];
  }
  return LISTERS[command.name]?.(command.args) ?? null;
}

/** `git ls-files` lists what git tracks, here or under the pathspecs it names. */
function trackedFiles(words: string[]): ListTarget {
  const specs = parseArgs(words, new Set(["x", "X", "--exclude", "--exclude-from"])).positional.filter((spec) => !/^:(!|\(exclude\))/.test(spec));
  return { path: ".", pattern: specs.map((spec) => shortGlob(spec.replace(/^:\(glob\)/, ""))).join(", ") || null };
}

const LISTERS: Record<string, (args: string[]) => ListTarget[] | null> = {
  ls: (args) => {
    const paths = parseArgs(args, new Set(["I", "w", "--ignore", "--hide", "--width"])).positional;
    return (paths.length ? paths : ["."]).map(globTarget);
  },
  tree: (args) => {
    const parsed = parseArgs(args, new Set(["L", "I", "P", "--filelimit"]));
    return [{ path: parsed.positional[0] ?? ".", pattern: parsed.values.get("P")?.[0] ?? null }];
  },
  find: (args) => {
    const start = args.findIndex((arg) => /^[-(!]/.test(arg));
    const paths = start < 0 ? args : args.slice(0, start);
    const named = args.findIndex((arg) => FIND_PATTERN.has(arg));
    if (args.some((arg) => /^-(exec|execdir|ok|delete)$/.test(arg))) return null;
    return (paths.length ? paths : ["."]).map((path) => ({ path: path.replace(/(.)\/+$/, "$1"), pattern: named >= 0 ? (args[named + 1] ?? null) : null }));
  },
  fd: (args) => {
    const parsed = parseArgs(args, new Set(["e", "t", "d", "E", "x", "X", "c", "j", "--extension", "--type", "--max-depth", "--exclude"]));
    const [pattern, path = "."] = parsed.positional;
    const extension = parsed.values.get("e")?.[0] ?? parsed.values.get("--extension")?.[0];
    return [{ path, pattern: pattern ?? (extension ? `*.${extension}` : null) }];
  },
};
