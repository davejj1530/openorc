/**
 * Plain words for commands everyone knows: `git status` reads as "Check git status", `pnpm test` as "Run the
 * tests", in the mood of the agent's own descriptions. Each label has the words for while it runs and for once it
 * is done, which a phase named after it uses. Commands nobody would recognise get no label, so they show as written.
 */

export interface RunLabel {
  /** The row's words: "Run the tests". */
  label: string;
  /** The same words while the command runs: "Running the tests". */
  live: string;
  /** The same words once it is done, for a phase named after it: "Ran the tests". */
  done: string;
  /** What it ran on, shown faint beside the label: a test file, a package. */
  detail?: string;
}

/** Each verb as a label says it, while it runs, and once done. */
const VERBS = {
  Ran: ["Run", "Running"],
  Viewed: ["View", "Viewing"],
  Checked: ["Check", "Checking"],
  Created: ["Create", "Creating"],
  Moved: ["Move", "Moving"],
  Copied: ["Copy", "Copying"],
  Deleted: ["Delete", "Deleting"],
  Opened: ["Open", "Opening"],
  Stopped: ["Stop", "Stopping"],
  Queried: ["Query", "Querying"],
  Wrote: ["Write", "Writing"],
  Edited: ["Edit", "Editing"],
  Changed: ["Change", "Changing"],
  Counted: ["Count", "Counting"],
  Staged: ["Stage", "Staging"],
  Untracked: ["Untrack", "Untracking"],
  Committed: ["Commit", "Committing"],
  Switched: ["Switch", "Switching"],
  Renamed: ["Rename", "Renaming"],
  Pushed: ["Push", "Pushing"],
  Pulled: ["Pull", "Pulling"],
  Stashed: ["Stash", "Stashing"],
  Listed: ["List", "Listing"],
  Restored: ["Restore", "Restoring"],
  Merged: ["Merge", "Merging"],
  Rebased: ["Rebase", "Rebasing"],
  Installed: ["Install", "Installing"],
  Started: ["Start", "Starting"],
  Formatted: ["Format", "Formatting"],
  Fetched: ["Fetch", "Fetching"],
  Cloned: ["Clone", "Cloning"],
  Called: ["Call", "Calling"],
} as const;
type Verb = keyof typeof VERBS;

export function said(verb: Verb, object: string, detail?: string): RunLabel {
  const words = (lead: string) => (object ? `${lead} ${object}` : lead);
  const [now, ing] = VERBS[verb];
  const label = { label: words(now), live: words(ing), done: words(verb) };
  return detail ? { ...label, detail } : label;
}

/**
 * Labels as one: "Run the tests, the typecheck and lint", "Format files and run a.cjs". A verb the label before
 * already said is not said again; past three, the rest are counted.
 */
export function joinLabels(labels: string[]): string {
  const shown = labels.length > 3 ? labels.slice(0, 2) : labels;
  const lead = (label: string | undefined) => label?.split(" ")[0];
  const named = shown.map((label, index) => {
    if (!index) return label;
    const verb = lead(shown[index - 1]);
    return label.startsWith(`${verb} `) ? label.slice(verb!.length + 1) : label.charAt(0).toLowerCase() + label.slice(1);
  });
  const parts = labels.length > 3 ? [...named, `${labels.length - 2} more`] : named;
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "");
}

export const basename = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || path;
/** One or two names, or how many: "notes.md", "a.ts and b.ts", "3 files". */
export const names = (paths: string[], noun = "file") => (paths.length <= 2 ? paths.map(basename).join(" and ") : `${paths.length} ${noun}s`);
const flags = (words: string[]) => words.filter((word) => /^-/.test(word));
const operands = (words: string[]) => words.filter((word) => !/^-/.test(word));

/** Words that run the command after them, with the options they take for themselves. */
function unwrapOnce(words: string[]): string[] | null {
  const [first = "", ...rest] = words;
  const name = basename(first);
  if (/^[A-Za-z_]\w*=/.test(first)) return rest;
  if (name === "env") return dropOptions(rest, /^(-u|--unset|-C|--chdir|-S)$/);
  if (/^(time|nohup|sudo|exec|builtin|caffeinate|corepack|stdbuf)$/.test(name)) return dropOptions(rest);
  if (name === "nice") return dropOptions(rest[0] === "-n" ? rest.slice(2) : rest);
  if (/^g?timeout$/.test(name)) return dropOptions(rest).slice(1);
  if (/^(npx|bunx|pnpx)$/.test(name)) return dropOptions(rest, /^(-p|--package)$/);
  if (name === "volta" && rest[0] === "run") return dropOptions(rest.slice(1), /^--(node|npm|yarn|pnpm|bundled-npm)$/);
  return null;
}

/** The options before a command's first operand, and the values of those in `valued`, and any VAR=value. */
function dropOptions(words: string[], valued: RegExp = /^$/): string[] {
  let at = 0;
  while (at < words.length && (/^-/.test(words[at]!) || /^[A-Za-z_]\w*=/.test(words[at]!))) at += valued.test(words[at]!) ? 2 : 1;
  return words.slice(at);
}

/** The command a step really runs, past `env`, `timeout`, `npx` and the like. */
export function unwrapWords(words: string[]): string[] {
  let current = words;
  for (let next = unwrapOnce(current); next; next = unwrapOnce(current)) current = next;
  return current;
}

/** What a package script is for, by its name: `typecheck`, `test:unit`, `dev`. */
function scriptLabel(script: string, detail?: string): RunLabel {
  if (/^test/.test(script)) return said("Ran", "the tests", detail);
  if (/typecheck|type-check|^tsc/.test(script)) return said("Ran", "the typecheck", detail);
  if (/^lint/.test(script)) return said("Ran", "lint", detail);
  if (/^build/.test(script)) return said("Ran", "the build", detail);
  if (/^(dev|start|serve)$/.test(script)) return said("Started", "the dev server", detail);
  if (/^(format|fmt|prettier)/.test(script)) return said("Formatted", "files", detail);
  return said("Ran", script, detail);
}

const MANAGER_VALUED = /^(--filter|-F|-C|--dir|--prefix|--cwd|--workspace|--store-dir|--reporter|--registry|--loglevel)$/;
/** The package managers' own commands, which are not scripts: `pnpm why`, `npm ls`. */
const MANAGER_BUILTINS =
  /^(licenses|why|outdated|list|ls|audit|store|config|view|info|publish|pack|link|unlink|prune|rebuild|root|bin|env|setup|init|patch|update|up|upgrade|remove|rm|uninstall|import|fetch|deploy|approve-builds|cache|help|version|whoami|login|logout)$|^-/;

/**
 * A package manager's words without its options and their values, and the package `--filter` scoped it to. With
 * `leading`, it stops at the first word that is not an option: the command.
 */
function managerWords(words: string[], leading: boolean): { operands: string[]; scope: string | undefined; end: number } {
  const found: string[] = [];
  let scope: string | undefined;
  let at = 0;
  for (; at < words.length; at++) {
    const word = words[at]!;
    if (!/^-/.test(word)) {
      if (leading) break;
      found.push(word);
      continue;
    }
    if (/^--(filter|workspace)=/.test(word)) scope = word.slice(word.indexOf("=") + 1);
    if (/^(--filter|-F|--workspace)$/.test(word)) scope = words[at + 1];
    if (MANAGER_VALUED.test(word)) at++;
  }
  return { operands: found, scope, end: at };
}

/** `pnpm --filter x test`, `npm run -s build`, `yarn workspace x lint`, `pnpm exec vitest`. */
function managerLabel(words: string[]): RunLabel | null {
  const lead = managerWords(words.slice(1), true);
  let rest = words.slice(1 + lead.end);
  let scope = lead.scope;
  if (rest[0] === "workspace") [scope, rest] = [rest[1], rest.slice(2)];
  const [sub = "install", ...args] = rest;
  if (/^(exec|dlx|x)$/.test(sub)) return commandLabel(args, null);
  const own = managerWords(args, false);
  scope ??= own.scope;
  if (/^(install|i|ci|add)$/.test(sub)) return said("Installed", own.operands.join(", ") || "dependencies", own.operands.length ? undefined : scope);
  if (/^(run|run-script)$/.test(sub)) return own.operands[0] ? scriptLabel(own.operands[0], scope) : null;
  if (sub === "t") return scriptLabel("test", scope);
  if (MANAGER_BUILTINS.test(sub)) return null;
  return programLabel([sub, ...args]) ?? scriptLabel(sub, scope);
}

/** The test file or files a runner was pointed at. */
function testTarget(args: string[]): string | undefined {
  const files = operands(args).filter((word) => /\.(test|spec)\.|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/.test(word));
  return files.length ? names(files) : undefined;
}

const option = (words: string[], ...names: string[]) => {
  const at = words.findIndex((word) => names.includes(word));
  return at >= 0 ? words[at + 1] : undefined;
};

type Labeler = (args: string[], input: string | null) => RunLabel | null;

const LANGUAGES: [RegExp, string][] = [
  [/^python[\d.]*$/, "a Python script"],
  [/^(node|bun)$/, "a Node script"],
  [/^(tsx|ts-node|deno)$/, "a TypeScript script"],
  [/^(bash|sh|zsh)$/, "a shell script"],
  [/^ruby$/, "a Ruby script"],
  [/^perl$/, "a Perl script"],
  [/^osascript$/, "an AppleScript"],
];
const INLINE = /^(-c|-e|--eval|-p|--print|-\w*c)$/;
const SCRIPT_FILE = /["'`]([^"'`\s]+\.(?:jsonl?|sqlite3?|db|[cm]?[jt]sx?|md|css|html|py|txt|log|csv|ya?ml|toml|png|svg))["'`]/;
const IMPORTED = /^\s*(?:import\s+([\w.]+)|from\s+([\w.]+)\s+import\b|import\b[^\n]*?\bfrom\s+["']([^"']+)["']|.*?\brequire\(\s*["']([^"']+)["'])/gm;
/** Modules nearly every script imports, which tell one script from another no better than its language. */
const COMMON =
  /^(node:.*|fs|path|os|url|util|crypto|child_process|json|sys|re|subprocess|pathlib|shutil|glob|time|datetime|collections|itertools|math|typing|argparse|random|hashlib|base64|io|csv|textwrap)(\.|$)/;

/** What an inline script works on, to tell two apart: the first file it names, or else the first module it imports. */
function scriptSubject(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const file = SCRIPT_FILE.exec(code)?.[1];
  if (file) return basename(file);
  return [...code.matchAll(IMPORTED)].map((match) => match.slice(1).find(Boolean)!).find((module) => !COMMON.test(module));
}

/**
 * A script by its file name, or by its language when the code came inline or from a heredoc (`python3 - arg`
 * reads it from the heredoc too). Only the options before the file are the interpreter's; the rest are the script's.
 */
function scriptRun(language: string, args: string[], input: string | null): RunLabel | null {
  const at = args.findIndex((word) => !/^-/.test(word) && word !== "run");
  const own = at < 0 ? args : args.slice(0, at);
  if (own.some((word) => INLINE.test(word))) return said("Ran", language, scriptSubject(args[at]));
  if (own.includes("-") || (at < 0 && input !== null)) return said("Ran", language, scriptSubject(input ?? undefined));
  const file = args[at];
  if (!file) return null;
  if (own.includes("--test")) return said("Ran", "the tests", testTarget(args.slice(at)));
  if (own.at(-1) === "-m") return /^(pytest|unittest)$/.test(file) ? said("Ran", "the tests", testTarget(args.slice(at + 1))) : said("Ran", file);
  return own.includes("--check") ? said("Checked", basename(file)) : said("Ran", basename(file));
}

/** A URL's host and port, as the place a request went. */
function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A process by the pattern that matched it: a name, the file it runs, or "a process" when the pattern is a regex. */
function processName(pattern: string): string {
  const path = pattern.split(/\s+/).findLast((word) => word.includes("/"));
  const name = path ? basename(path) : pattern;
  return /[\s*?()[\]|^$\\]/.test(name) || name.startsWith(".") ? "a process" : name;
}

/** The database a client queried: its file, which may sit in a folder with spaces, or the name passed to it. */
function database(args: string[]): string {
  const words = operands(args.filter((_, at) => !/^-[hpUWd]$/.test(args[at - 1] ?? "")));
  const named = option(args, "-d", "--dbname") ?? words.find((word) => /\.(sqlite3?|db)(\?|$)/.test(word)) ?? words.find((word) => !/\s/.test(word));
  const file = named?.replace(/^file:/, "").replace(/\?.*$/, "");
  return file && !file.includes("$") ? basename(file) : "a database";
}

/** A tool whose subcommands worth naming each have a label; any other subcommand has none. */
const subcommand =
  (labels: Record<string, () => RunLabel>): Labeler =>
  (args) =>
    labels[args[0] ?? ""]?.() ?? null;

const PROGRAMS: Record<string, Labeler> = {
  git: (args, input) => gitLabel(args, input),
  gh: (args) => ghLabel(args),
  vitest: (args) => said("Ran", "the tests", testTarget(args)),
  jest: (args) => said("Ran", "the tests", testTarget(args)),
  mocha: (args) => said("Ran", "the tests", testTarget(args)),
  pytest: (args) => said("Ran", "the tests", testTarget(args)),
  playwright: (args) => (args[0] === "test" ? said("Ran", "the tests", testTarget(args)) : null),
  tsc: (args) => said("Ran", "the typecheck", option(args, "-p", "--project")),
  "vue-tsc": () => said("Ran", "the typecheck"),
  mypy: () => said("Ran", "the typecheck"),
  pyright: () => said("Ran", "the typecheck"),
  eslint: () => said("Ran", "lint"),
  ruff: (args) => (args[0] === "format" ? said("Formatted", "files") : said("Ran", "lint")),
  biome: () => said("Ran", "lint"),
  stylelint: () => said("Ran", "lint"),
  prettier: (args) => (args.includes("--check") ? said("Checked", "formatting") : said("Formatted", "files")),
  vite: (args) => (args[0] === "build" ? said("Ran", "the build") : said("Started", "the dev server")),
  next: subcommand({ build: () => said("Ran", "the build"), dev: () => said("Started", "the dev server") }),
  astro: subcommand({ build: () => said("Ran", "the build"), dev: () => said("Started", "the dev server") }),
  "electron-vite": (args) => (args[0] === "build" ? said("Ran", "the build") : said("Started", "the dev server")),
  go: subcommand({ test: () => said("Ran", "the tests"), build: () => said("Ran", "the build") }),
  cargo: subcommand({ test: () => said("Ran", "the tests"), build: () => said("Ran", "the build") }),
  docker: (args) => (args[0] === "build" ? said("Ran", "the build") : null),
  electron: (args) => {
    const file = operands(args)[0];
    return file ? said("Ran", basename(file)) : said("Started", "Electron");
  },
  brew: (args) => (args[0] === "install" ? said("Installed", operands(args.slice(1)).join(", ")) : null),
  curl: (args) => {
    const url = args.findLast((word) => /^https?:\/\//.test(word));
    return url ? said("Fetched", host(url)) : null;
  },
  wget: (args) => {
    const url = args.findLast((word) => /^https?:\/\//.test(word));
    return url ? said("Fetched", host(url)) : null;
  },
  mkdir: (args) => (operands(args).length ? said("Created", names(operands(args), "folder")) : null),
  touch: (args) => (operands(args).length ? said("Created", names(operands(args))) : null),
  rm: (args) => (operands(args).length ? said("Deleted", names(operands(args))) : null),
  rmdir: (args) => (operands(args).length ? said("Deleted", names(operands(args), "folder")) : null),
  mv: (args) => (operands(args).length > 1 ? said("Moved", names(operands(args).slice(0, -1))) : null),
  cp: (args) => (operands(args).length > 1 ? said("Copied", names(operands(args).slice(0, -1))) : null),
  chmod: (args) => (operands(args).length > 1 ? said("Changed", `permissions of ${names(operands(args).slice(1))}`) : null),
  open: (args) => {
    // `open -a Safari page.html` opens the page; the app is only how.
    const target = operands(args.filter((_, at) => !/^-[ab]$/.test(args[at - 1] ?? ""))).at(-1) ?? option(args, "-a");
    if (!target) return null;
    return said("Opened", /^https?:\/\//.test(target) ? host(target) : basename(target));
  },
  kill: () => said("Stopped", "a process"),
  pkill: (args) => (operands(args)[0] ? said("Stopped", processName(operands(args)[0]!)) : null),
  killall: (args) => (operands(args)[0] ? said("Stopped", operands(args)[0]!) : null),
  sqlite3: (args) => said("Queried", database(args)),
  psql: (args) => said("Queried", database(args)),
  jq: (args) => (operands(args)[1] ? said("Queried", basename(operands(args)[1]!)) : null),
  wc: (args) => (operands(args).length ? said("Counted", `lines in ${names(operands(args))}`) : null),
  tee: (args) => (operands(args).length ? said("Wrote", names(operands(args))) : null),
};
/** A known program's label, by the name it was run as. `bun` runs a file as a script and anything else as npm would. */
function programLabel(words: string[], input: string | null = null): RunLabel | null {
  const name = basename(words[0] ?? "");
  const args = words.slice(1);
  const runsFile = name === "bun" && /\.[cm]?[jt]sx?$/.test(args[0] ?? "");
  if (/^(pnpm|npm|yarn|bun)$/.test(name) && !runsFile) return managerLabel(words);
  const language = LANGUAGES.find(([pattern]) => pattern.test(name))?.[1];
  if (language) return scriptRun(language, args, input);
  if (/^pip\d*$/.test(name)) return args[0] === "install" ? said("Installed", operands(args.slice(1)).join(", ") || "dependencies") : null;
  return PROGRAMS[name]?.(args, input) ?? null;
}

/**
 * A command's plain label, or null when it is not one people know. `input` is what a heredoc fed it, which makes
 * `python3 -` an inline script. A script run by its path, such as `./scripts/release.sh`, reads as its file name.
 */
export function commandLabel(words: string[], input: string | null): RunLabel | null {
  const command = unwrapWords(words);
  const label = programLabel(command, input);
  if (label) return label;
  const first = command[0] ?? "";
  return first.includes("/") && /\.\w+$/.test(first) ? said("Ran", basename(first)) : null;
}

/** Steps that only prepare for the step that matters: `mkdir -p out && node build.mjs` is about the build. */
export function isPreparation(words: string[]): boolean {
  return /^(mkdir|chmod|touch|ln)$/.test(basename(unwrapWords(words)[0] ?? ""));
}

const GIT_VALUED = /^(-C|-c|--git-dir|--work-tree)$/;
/** Paths among a diff's operands, past the commits and ranges it compares. */
const diffPaths = (files: string[]) => files.filter((file) => !/\.\.|^HEAD|^[0-9a-f]{7,}$|^(origin|upstream)\//.test(file));

/** Git by what it did: "Check git status", "Commit “Fix the row”". `input` is what a heredoc fed it, as `-F -` reads. */
function gitLabel(words: string[], input: string | null): RunLabel | null {
  const at = words.findIndex((word, index) => !/^-/.test(word) && !GIT_VALUED.test(words[index - 1] ?? ""));
  const sub = words[at] ?? "";
  const args = words.slice(at + 1);
  const files = operands(args.filter((word) => word !== "--"));
  return GIT[sub]?.(args, files, input) ?? null;
}

/** The body of the heredoc a `$(cat <<'EOF' … EOF)` substitution prints. */
const heredocBody = (text: string) => /<<-?\s*['"]?([\w.-]+)['"]?[^\n]*\n([\s\S]*?)\n\s*\1\s*(\n|\)|$)/.exec(text)?.[2];

/** A commit's subject: the first line of `-m`, of the heredoc inside it, or of the heredoc `-F -` reads. */
function commitSubject(args: string[], input: string | null): string | undefined {
  const message = option(args, "-m", "--message");
  const text = message?.startsWith("$(") ? heredocBody(message) : (message ?? (option(args, "-F", "--file") === "-" ? input : null));
  return text
    ?.split("\n")
    .map((line) => line.trim())
    .find(Boolean);
}

/** A branch command by its flags: only a bare name creates one; `--list`, `--contains`, `-a` and the like look. */
function branchLabel(args: string[], [name, to]: string[]): RunLabel {
  const own = flags(args);
  if (name && own.some((flag) => /^(-[dD]|--delete)$/.test(flag))) return said("Deleted", `branch ${name}`);
  if (name && own.some((flag) => /^(-[mM]|--move)$/.test(flag))) return said("Renamed", to ? `branch ${name} to ${to}` : `branch to ${name}`);
  if (name && own.every((flag) => /^(-[ft]|--force|--track|--no-track)$/.test(flag))) return said("Created", `branch ${name}`);
  return said("Listed", "branches");
}

const STASH: Record<string, () => RunLabel> = {
  list: () => said("Listed", "stashes"),
  show: () => said("Viewed", "a stash"),
  drop: () => said("Deleted", "a stash"),
  clear: () => said("Deleted", "all stashes"),
  pop: () => said("Restored", "stashed changes"),
  apply: () => said("Restored", "stashed changes"),
};

const GIT: Record<string, (args: string[], files: string[], input: string | null) => RunLabel | null> = {
  status: () => said("Checked", "git status"),
  diff: (args, files) => (args.includes("--check") ? said("Checked", "the diff for whitespace") : said("Viewed", "the diff", diffPaths(files).length ? names(diffPaths(files)) : undefined)),
  log: () => said("Viewed", "git history"),
  show: (_, [target]) => {
    const [revision = "HEAD", file] = (target ?? "HEAD").split(":");
    if (file) return said("Viewed", `${basename(file)} at ${revision.slice(0, 7)}`);
    if (revision === "HEAD") return said("Viewed", "the last commit");
    return said("Viewed", `commit ${/^[0-9a-f]{7,}$/.test(revision) ? revision.slice(0, 7) : revision}`);
  },
  add: (args, files) => said("Staged", args.some((word) => /^(-A|--all|\.)$/.test(word)) ? "all changes" : names(files)),
  commit: (args, _, input) => {
    const subject = commitSubject(args, input);
    return subject ? said("Committed", `“${subject}”`) : said("Committed", "");
  },
  branch: branchLabel,
  checkout: (args, files) => {
    const branch = option(args, "-b", "-B");
    if (branch) return said("Created", `branch ${branch}`);
    if (args.includes("--")) return said("Restored", names(files.slice(1).length ? files.slice(1) : files));
    return files[0] ? said("Switched", `to ${files[0]}`) : null;
  },
  switch: (args, files) => {
    const branch = option(args, "-c", "-C", "--create");
    if (branch) return said("Created", `branch ${branch}`);
    return files[0] ? said("Switched", `to ${files[0]}`) : null;
  },
  restore: (_, files) => (files.length ? said("Restored", names(files)) : null),
  push: (_, files) => said("Pushed", files[1] ?? ""),
  pull: () => said("Pulled", "changes"),
  fetch: () => said("Fetched", "updates"),
  clone: (_, files) => {
    const url = files.find((file) => /:\/\/|^git@/.test(file));
    return url ? said("Cloned", basename(url).replace(/\.git$/, "")) : null;
  },
  stash: ([action = ""]) => STASH[action]?.() ?? said("Stashed", "changes"),
  merge: (_, [branch]) => (branch ? said("Merged", branch) : null),
  rebase: (_, [onto]) => (onto ? said("Rebased", `onto ${onto}`) : null),
  // `--cached` keeps the file and only stops tracking it.
  rm: (args, files) => (files.length ? said(args.includes("--cached") ? "Untracked" : "Deleted", names(files)) : null),
  mv: (_, files) => (files.length > 1 ? said("Moved", names(files.slice(0, -1))) : null),
};

/** The GitHub CLI by what it looked at. */
function ghLabel([area, action, target]: string[]): RunLabel | null {
  if (area === "pr" && action === "view") return said("Viewed", target && /^\d+$/.test(target) ? `PR #${target}` : "the pull request");
  if (area === "pr" && action === "create") return said("Opened", "a pull request");
  if (area === "pr" && action === "checks") return said("Checked", "the PR's checks");
  if (area === "run" && action === "view") return said("Viewed", "a CI run");
  if (area === "run" && action === "list") return said("Listed", "CI runs");
  if (area === "api") return said("Called", "the GitHub API");
  return null;
}
