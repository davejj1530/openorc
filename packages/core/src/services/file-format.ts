import { execFile, type ExecFileException } from "node:child_process";
import { access, constants, readFile } from "node:fs/promises";
import { dirname, extname, join, sep } from "node:path";
import type { FolderPath, FormatResult } from "@openorc/protocol";
import type { ConversationFolder, FolderKind } from "./conversation-folder.js";
import { MAX_FILE_BYTES } from "./file-write.js";
import { resolveBinary } from "./shell-environment.js";

/** The Prettier that ships with the app. It runs off the core's thread (formatter-host.ts) and reads no project config. */
export interface BundledFormatter {
  /** `text` as Prettier formats a file named `filepath`, whose extension picks the parser. Rejects with Prettier's error. */
  format(text: string, filepath: string): Promise<string>;
}

/** How long any formatter may take before it is stopped and the file saves as typed. */
export const FORMAT_TIMEOUT_MS = 8_000;

/** The login shell's environment as the core captured it: its PATH finds formatters a project doesn't install. */
export interface FormatterEnvironment {
  path: string;
  env: Readonly<Record<string, string>>;
}

type FormatterId = "prettier" | "biome" | "ruff" | "black" | "gofmt" | "rustfmt";

/** How a project declares a formatter, where it installs it, and how to make it format stdin. */
interface ProjectFormatter {
  name: string;
  bin: string;
  /** Whether a folder's files say the project formats with it. */
  declares: (dir: string) => Promise<boolean>;
  /** Where a project installs the executable, under the declaring folder or any folder above it in the conversation's. */
  installs: readonly string[];
  /** Arguments that make it read `file`'s text from stdin and print the result. `dir` is the declaring folder. */
  args: (file: string, dir: string) => string[] | Promise<string[]>;
}

const readText = (file: string) => readFile(file, "utf8").catch(() => null);
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );
const executable = (file: string) =>
  access(file, constants.X_OK).then(
    () => true,
    () => false,
  );
const anyOf = (names: readonly string[]) => async (dir: string) => (await Promise.all(names.map((name) => exists(join(dir, name))))).some(Boolean);
/** A table pyproject.toml configures, such as [tool.ruff] or [tool.ruff.format]. */
const pyprojectTable = (tool: string) => async (dir: string) => new RegExp(`^\\[tool\\.${tool}[\\].]`, "m").test((await readText(join(dir, "pyproject.toml"))) ?? "");

const prettierConfigs = anyOf([
  ".prettierrc",
  ...["json", "yaml", "yml", "json5", "toml", "js", "cjs", "mjs", "ts", "cts", "mts"].map((extension) => `.prettierrc.${extension}`),
  ...["js", "cjs", "mjs", "ts", "cts", "mts"].map((extension) => `prettier.config.${extension}`),
]);

/** A package.json with a "prettier" key, or with Prettier among its dependencies. */
async function packageUsesPrettier(dir: string): Promise<boolean> {
  try {
    const manifest = JSON.parse((await readText(join(dir, "package.json"))) ?? "null") as { prettier?: unknown; dependencies?: object; devDependencies?: object } | null;
    return Boolean(manifest && ("prettier" in manifest || [manifest.dependencies, manifest.devDependencies].some((dependencies) => dependencies && "prettier" in dependencies)));
  } catch {
    return false;
  }
}

/** rustfmt reading stdin assumes the 2015 edition, which fails on newer syntax, so the crate's own edition is passed. */
async function rustfmtArgs(_file: string, dir: string): Promise<string[]> {
  const edition = /^\s*edition\s*=\s*"(\d{4})"/m.exec((await readText(join(dir, "Cargo.toml"))) ?? "")?.[1];
  return edition ? ["--edition", edition] : [];
}

const FORMATTERS: Record<FormatterId, ProjectFormatter> = {
  prettier: {
    name: "Prettier",
    bin: "prettier",
    declares: async (dir) => (await prettierConfigs(dir)) || packageUsesPrettier(dir),
    installs: ["node_modules/.bin"],
    args: (file) => ["--stdin-filepath", file],
  },
  biome: { name: "Biome", bin: "biome", declares: anyOf(["biome.json", "biome.jsonc"]), installs: ["node_modules/.bin"], args: (file) => ["format", `--stdin-file-path=${file}`] },
  ruff: {
    name: "Ruff",
    bin: "ruff",
    declares: async (dir) => (await anyOf(["ruff.toml", ".ruff.toml"])(dir)) || pyprojectTable("ruff")(dir),
    installs: [".venv/bin", "venv/bin"],
    args: (file) => ["format", "--stdin-filename", file, "-"],
  },
  black: { name: "Black", bin: "black", declares: pyprojectTable("black"), installs: [".venv/bin", "venv/bin"], args: (file) => ["--quiet", "--stdin-filename", file, "-"] },
  gofmt: { name: "gofmt", bin: "gofmt", declares: anyOf(["go.mod"]), installs: [], args: () => [] },
  rustfmt: { name: "rustfmt", bin: "rustfmt", declares: anyOf(["Cargo.toml"]), installs: [], args: rustfmtArgs },
};

/** A file type's formatters: the project's, first declared and installed wins, and whether the bundled Prettier knows it. */
interface Language {
  extensions: readonly string[];
  project: readonly FormatterId[];
  bundled: boolean;
}

/** The one table to extend for a new language or formatter. */
const LANGUAGES: readonly Language[] = [
  { extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".json", ".jsonc"], project: ["biome", "prettier"], bundled: true },
  { extensions: [".css", ".scss", ".less", ".html", ".vue", ".md", ".markdown", ".mdx", ".yaml", ".yml", ".graphql", ".gql"], project: ["prettier"], bundled: true },
  { extensions: [".py", ".pyi"], project: ["ruff", "black"], bundled: false },
  { extensions: [".go"], project: ["gofmt"], bundled: false },
  { extensions: [".rs"], project: ["rustfmt"], bundled: false },
];

/** Copies of someone else's code: a pull request under review and a team member's work in progress. Their tools never run. */
const UNVETTED: ReadonlySet<FolderKind> = new Set(["review", "member"]);

/** A project's formatter, ready to run in the folder that declared it. */
interface Command {
  name: string;
  bin: string;
  args: string[];
  cwd: string;
}

/** The file's folder and each one above it, up to and including the conversation's folder. */
function foldersUp(root: string, file: string): string[] {
  const folders: string[] = [];
  for (let dir = dirname(file); dir !== root && dir.startsWith(root + sep); dir = dirname(dir)) folders.push(dir);
  return [...folders, root];
}

async function firstWhere(folders: readonly string[], test: (dir: string) => Promise<boolean>): Promise<string | null> {
  for (const dir of folders) if (await test(dir)) return dir;
  return null;
}

/** The first formatter for the file the project declares and has installed, in the project or on the login shell's PATH. */
async function projectCommand(language: Language, root: string, file: string, loginPath: string): Promise<Command | null> {
  const folders = foldersUp(root, file);
  for (const id of language.project) {
    const formatter = FORMATTERS[id];
    const declaring = await firstWhere(folders, formatter.declares);
    if (declaring === null) continue;
    const installs = folders.slice(folders.indexOf(declaring)).flatMap((dir) => formatter.installs.map((install) => join(dir, install, formatter.bin)));
    const bin = (await firstWhere(installs, executable)) ?? (await resolveBinary(formatter.bin, loginPath));
    if (bin) return { name: formatter.name, bin, args: await formatter.args(file, declaring), cwd: declaring };
  }
  return null;
}

/** The core's own process runs with ELECTRON_RUN_AS_NODE, which no formatter should inherit. */
function formatterEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const copy = { ...env };
  delete copy["ELECTRON_RUN_AS_NODE"];
  return copy;
}

function commandFailure(error: ExecFileException, stderr: string, timeoutMs: number): string {
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "its output is larger than a file can be saved at (2 MB)";
  if (error.killed) return `it took longer than ${timeoutMs / 1000} seconds and was stopped`;
  if (typeof error.code === "string") return `it couldn't start (${error.code})`;
  return stderr.split("\n").find((line) => line.trim()) ?? `it exited with code ${error.code}`;
}

/** Feeds `text` to a project's formatter on stdin and answers what it prints, within the timeout and the save size limit. */
function runCommand({ bin, args, cwd }: Command, text: string, env: Record<string, string>, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { cwd, env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_FILE_BYTES, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(commandFailure(error, stderr, timeoutMs)));
      else resolve(stdout);
    });
    child.stdin?.on("error", () => {}); // An early exit is reported by the callback.
    child.stdin?.end(text);
  });
}

const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n").find((line) => line.trim()) ?? "it failed";

/** A formatter that applies to one file: its name for notes, and the call that formats its text. */
interface Formatter {
  name: string;
  format: (text: string) => Promise<string>;
}

interface FileFormatterDependencies {
  bundled: BundledFormatter | null;
  environment: () => FormatterEnvironment;
  timeoutMs?: number;
}

/**
 * Which formatter formats a file, and running it. A project formatter (its own Prettier or Biome, the Ruff or Black it
 * configures, gofmt for a Go module, rustfmt for a Cargo package) formats whenever it applies. Otherwise the bundled
 * Prettier may stand in for the web languages, which a save allows only for files created here, so a one-line fix
 * never restyles a file nobody formatted. Nothing runs in a copy of someone else's code.
 */
export class FileFormatter {
  constructor(private readonly deps: FileFormatterDependencies) {}

  /**
   * `text` as the file's formatter writes it. `fallback` lets the bundled Prettier stand in when the project has no
   * formatter for the file. A formatter that fails answers `failed` with its name and first line of complaint.
   */
  async format(folder: Pick<ConversationFolder, "root" | "kind">, path: FolderPath, text: string, fallback: boolean): Promise<FormatResult> {
    const formatter = await this.choose(folder, path, fallback);
    if (!formatter) return { kind: "unavailable" };
    try {
      const formatted = await formatter.format(text);
      if (!formatted && text.trim()) throw new Error("it returned no text");
      return formatted === text ? { kind: "unchanged" } : { kind: "formatted", text: formatted };
    } catch (error) {
      return { kind: "failed", message: `${formatter.name}: ${firstLine(error)}` };
    }
  }

  private async choose(folder: Pick<ConversationFolder, "root" | "kind">, path: FolderPath, fallback: boolean): Promise<Formatter | null> {
    const language = LANGUAGES.find((entry) => entry.extensions.includes(extname(path).toLowerCase()));
    if (!language || UNVETTED.has(folder.kind)) return null;
    const { path: loginPath, env } = this.deps.environment();
    const command = await projectCommand(language, folder.root, join(folder.root, path), loginPath);
    if (command) return { name: command.name, format: (text) => runCommand(command, text, formatterEnv(env), this.deps.timeoutMs ?? FORMAT_TIMEOUT_MS) };
    const bundled = this.deps.bundled;
    return fallback && language.bundled && bundled ? { name: "Prettier", format: (text) => bundled.format(text, path) } : null;
  }
}
