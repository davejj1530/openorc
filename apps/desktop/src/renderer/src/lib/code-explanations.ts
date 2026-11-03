import { create } from "zustand";
import { explainLimits, type CodeExplainResult, type ExplanationView, type FileScope, type FolderPath } from "@openorc/protocol";
import { core } from "./rpc";

export interface ExplainRequest {
  scope: FileScope;
  path: FolderPath;
  view: ExplanationView;
  text: string;
}

/**
 * One file explained one way. `text` is what was sent, so an edited buffer reads as changed since rather than asking
 * again on every keystroke. While a new explanation is on its way the last one stays on screen.
 */
export type Explanation = { state: "explaining"; text: string; request: number; previous: Answered | null } | Answered;
type Answered = { state: "answered"; text: string; request: number; result: CodeExplainResult };

interface State {
  entries: Record<string, Explanation>;
  /** Asks once per file and view, and again when the file was too empty or long to explain and its text has changed since. */
  ensure: (request: ExplainRequest) => void;
  /** Asks again for the text shown now, past the core's cache. */
  refresh: (request: ExplainRequest) => void;
}

/** Entries kept for this window, the least recently asked going first. */
const KEPT = 40;
let requests = 0;

const scopeKey = (scope: FileScope) => (scope.kind === "project" ? `project:${scope.id}:${scope.workingDirectory ?? ""}` : `${scope.kind}:${scope.id}`);
export const explanationKey = (request: Pick<ExplainRequest, "scope" | "path" | "view">) => `${scopeKey(request.scope)}\n${request.path}\n${request.view}`;

function localReason(text: string): string | null {
  return text.length > explainLimits.characters ? "This file is too large to explain." : null;
}

export const useExplanations = create<State>((set, get) => {
  const put = (key: string, entry: Explanation) => {
    const rest = Object.entries(get().entries).filter(([other]) => other !== key);
    set({ entries: Object.fromEntries([...rest.slice(-(KEPT - 1)), [key, entry]]) });
  };
  const ask = (request: ExplainRequest, refresh: boolean) => {
    const key = explanationKey(request);
    const current = get().entries[key];
    const number = ++requests;
    const answer = (result: CodeExplainResult) => {
      if (get().entries[key]?.request === number) put(key, { state: "answered", text: request.text, request: number, result });
    };
    const reason = localReason(request.text);
    if (reason) return put(key, { state: "answered", text: request.text, request: number, result: { kind: "unavailable", reason, settings: false } });
    put(key, { state: "explaining", text: request.text, request: number, previous: current?.state === "answered" ? current : (current?.previous ?? null) });
    void core
      .call("code.explain", { ...request, ...(refresh ? { refresh } : {}) })
      .then(answer, (error: unknown) => answer({ kind: "failed", reason: error instanceof Error ? error.message : "Explaining failed." }));
  };
  return {
    entries: {},
    ensure: (request) => {
      const entry = get().entries[explanationKey(request)];
      const outgrown = entry?.state === "answered" && entry.result.kind === "unavailable" && !entry.result.settings && entry.text !== request.text;
      if (!entry || outgrown) ask(request, false);
    },
    refresh: (request) => ask(request, true),
  };
});
