import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { compileFunction } from "node:vm";
import ts from "typescript";

/*
 * The transcript code phone builds already installed run on every event a host sends them, byte for byte as released
 * and compiled here as it is. Frozen on purpose: a file in `installed-transcripts/` is never edited, which `blob`
 * holds it to. What a build's code throws on, its phones abort on.
 * - appStore: App Store 1.0.0 (202610270002), `packages/client/src/transcript.ts` as of 85bf1c5e. It calls a handler
 *   for every event type it is sent and has none for a type added since.
 * - release: 1.2.0 (202610270006) and its update of 2026-11-10, as of 6170f205; the last update of 1.1.0 runs the same
 *   two files. It leaves out a type it has no handler for.
 */

interface Block {
  id: string;
  kind: string;
  [field: string]: unknown;
}

/** One run as a build draws it. */
export interface InstalledRun {
  blocks: Block[];
  [field: string]: unknown;
}

export interface InstalledTranscript {
  emptyRun(runId: string): InstalledRun;
  /** Throws where the build's own code throws. */
  applyEvents(run: InstalledRun, events: readonly unknown[]): void;
}

type Sources = Record<string, { file: string; blob: string }>;

const BUILDS = {
  appStore: { transcript: { file: "app-store-1.0.0.transcript.ts.txt", blob: "4f27c4052ed9d652dbd84491928da425c71a82e7" } },
  release: {
    transcript: { file: "release-1.2.0.transcript.ts.txt", blob: "48e51e4fd3342c452058cd54fbde85d1fdba058c" },
    "transcript-subagents": { file: "release-1.2.0.transcript-subagents.ts.txt", blob: "72e8c600b1e592973fb0e14895d91f48aefdbf15" },
  },
} satisfies Record<string, Sources>;

/** The file's text, refused unless it is the released file: git's own id of its bytes. */
function released({ file, blob }: Sources[string]): string {
  const bytes = readFileSync(new URL(`./installed-transcripts/${file}`, import.meta.url));
  const id = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (id !== blob) throw new Error(`${file} is not the released file any more (${id}). It is frozen: restore it from git.`);
  return bytes.toString("utf8");
}

/** The build's modules as CommonJS, each run once; they import only each other and types. */
function load(sources: Sources): InstalledTranscript {
  const loaded = new Map<string, { exports: Record<string, unknown> }>();
  const require = (specifier: string): Record<string, unknown> => {
    const name = specifier.replace(/^\.\//, "").replace(/\.js$/, "");
    const cached = loaded.get(name);
    if (cached) return cached.exports;
    const source = sources[name];
    if (!source) throw new Error(`The installed transcript imports ${specifier}, which is not frozen here.`);
    const module = { exports: {} as Record<string, unknown> };
    loaded.set(name, module);
    const { outputText } = ts.transpileModule(released(source), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
    compileFunction(outputText, ["exports", "require", "module"])(module.exports, require, module);
    return module.exports;
  };
  return require("./transcript.js") as unknown as InstalledTranscript;
}

export const INSTALLED_TRANSCRIPTS = { appStore: load(BUILDS.appStore), release: load(BUILDS.release) };
