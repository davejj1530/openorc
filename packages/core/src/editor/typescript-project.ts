import { statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { editorText, type EditorDocument } from "@openorc/protocol";

const MAX_SOURCE = 2 * 1024 * 1024;
const canonical = (file: string): string => (ts.sys.useCaseSensitiveFileNames ? resolve(file) : resolve(file).toLowerCase());

export function inside(root: string, file: string): boolean {
  const local = relative(root, file);
  return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

export function sourceText(file: string): string | undefined {
  try {
    if (statSync(file).size > MAX_SOURCE) return undefined;
    const text = ts.sys.readFile(file);
    return text === undefined || text.includes("\0") ? undefined : editorText(text);
  } catch {
    return undefined;
  }
}

function diskVersion(file: string): string {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

function configFor(root: string, file: string): string | null {
  for (let directory = dirname(file); inside(root, directory); directory = dirname(directory)) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const config = resolve(directory, name);
      if (ts.sys.fileExists(config)) return referencedConfig(config, file, new Set()) ?? config;
    }
    if (directory === root || dirname(directory) === directory) break;
  }
  return null;
}

/** Solution-style configs point at the web/node projects that actually own the file and its JSX/options. */
function referencedConfig(config: string, file: string, seen: Set<string>): string | null {
  if (seen.has(config) || seen.size >= 32) return null;
  seen.add(config);
  const read = ts.readConfigFile(config, ts.sys.readFile);
  if (read.error) return null;
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(config), undefined, config);
  if (parsed.fileNames.some((entry) => canonical(entry) === canonical(file))) return config;
  for (const reference of parsed.projectReferences ?? []) {
    const path = reference.path.endsWith(".json") ? reference.path : resolve(reference.path, "tsconfig.json");
    const match = referencedConfig(path, file, seen);
    if (match) return match;
  }
  return null;
}

interface Configuration {
  options: ts.CompilerOptions;
  fileNames: string[];
  projectReferences?: readonly ts.ProjectReference[];
}

function configuration(directory: string, config: string | null): Configuration {
  if (config) {
    const read = ts.readConfigFile(config, ts.sys.readFile);
    if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(config), undefined, config);
    if (parsed.fileNames.length > 10_000) throw new Error("This TypeScript project has more than 10,000 source files.");
    return { ...parsed, options: { ...parsed.options, allowJs: true, noEmit: true } };
  }
  const fileNames = ts.sys.readDirectory(
    directory,
    [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    ["**/node_modules/**", "**/.*/**", "**/dist/**", "**/build/**", "**/out/**", "**/coverage/**"],
    ["**/*"],
    4,
  );
  if (fileNames.length > 2_000) throw new Error("This folder has more than 2,000 source files. Add a tsconfig.json or jsconfig.json to choose which files to analyze.");
  return {
    fileNames,
    options: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      allowJs: true,
      checkJs: true,
      strict: true,
      allowImportingTsExtensions: true,
      noEmit: true,
    },
  };
}

/** One TypeScript project in a real worktree. Each request replaces the entire unsaved overlay, including removals. */
export class TypeScriptProject {
  readonly service: ts.LanguageService;
  private documents = new Map<string, string>();
  private fileNames: string[] = [];
  private readonly versions = new Map<string, number>();
  private version = 0;
  private config: Configuration;
  private configStamp: string;
  private scanAfter = 0;

  constructor(
    readonly root: string,
    readonly configPath: string | null,
    private readonly inferredDirectory = root,
  ) {
    this.config = configuration(inferredDirectory, configPath);
    this.configStamp = configPath ? diskVersion(configPath) : "inferred";
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => this.config.options,
      getScriptFileNames: () => [...new Map([...this.config.fileNames, ...this.fileNames].map((file) => [canonical(file), file])).values()],
      getScriptVersion: (file) => (this.documents.has(canonical(file)) ? `buffer:${this.versions.get(canonical(file))}` : diskVersion(file)),
      getScriptSnapshot: (file) => {
        const text = this.read(file);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => root,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      getProjectReferences: () => this.config.projectReferences,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      readFile: (file) => this.read(file),
      fileExists: (file) => this.documents.has(canonical(file)) || ts.sys.fileExists(file),
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
    };
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, root));
  }

  read(file: string): string | undefined {
    return this.documents.get(canonical(file)) ?? sourceText(file);
  }

  update(documents: EditorDocument[]): void {
    this.fileNames = documents.map((document) => resolve(this.root, document.path));
    const next = new Map(documents.map((document) => [canonical(resolve(this.root, document.path)), editorText(document.text)]));
    for (const [file, text] of next) if (this.documents.get(file) !== text) this.versions.set(file, ++this.version);
    this.documents = next;
    const stamp = this.configPath ? diskVersion(this.configPath) : "inferred";
    if (stamp !== this.configStamp || Date.now() > this.scanAfter) {
      this.config = configuration(this.inferredDirectory, this.configPath);
      this.configStamp = stamp;
      this.scanAfter = Date.now() + 5_000;
    }
  }

  dispose(): void {
    this.service.dispose();
  }
}

/** Only the four most recently used projects stay warm. Files in distinct worktrees never share a project. */
export class TypeScriptProjects {
  private readonly projects = new Map<string, TypeScriptProject>();
  private readonly configurations = new Map<string, { path: string | null; until: number }>();

  get(root: string, file: string, documents: EditorDocument[]): TypeScriptProject {
    const fileKey = JSON.stringify([root, file]);
    const saved = this.configurations.get(fileKey);
    const config = saved && saved.until > Date.now() ? saved.path : configFor(root, file);
    if (!saved || saved.until <= Date.now()) this.configurations.set(fileKey, { path: config, until: Date.now() + 5_000 });
    if (this.configurations.size > 200) this.configurations.clear();
    const directory = config ? root : dirname(file);
    const key = JSON.stringify([root, config, directory]);
    const project = this.projects.get(key) ?? new TypeScriptProject(root, config, directory);
    this.projects.delete(key);
    this.projects.set(key, project);
    project.update(documents);
    for (const [oldest, unused] of this.projects) {
      if (this.projects.size <= 4) break;
      unused.dispose();
      this.projects.delete(oldest);
    }
    return project;
  }

  dispose(): void {
    for (const project of this.projects.values()) project.dispose();
    this.projects.clear();
    this.configurations.clear();
  }
}
