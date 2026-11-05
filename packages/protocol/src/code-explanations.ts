import { z } from "zod";
import { FileScope, FolderPath } from "./files.js";
import type { HarnessId } from "./harness.js";

/** The ways to read a code file besides its source: prose, a block-by-block walkthrough, and a diagram of its logic. */
export const ExplanationView = z.enum(["english", "walkthrough", "diagram"]);
export type ExplanationView = z.infer<typeof ExplanationView>;

/** The longest text the explainer reads. Longer files would cost minutes and a large share of a small model's context. */
export const explainLimits = { lines: 2_000, characters: 160_000 } as const;

/** Prose files read as they are; every other text file can be explained. */
export const explainable = (path: string): boolean => !/\.(md|markdown|mdx|txt)$/i.test(path);

export const codeExplanationRpcParams = {
  /**
   * Explains `text`, the file as the editor shows it, with the text-generation model. The same text explained the same
   * way answers from the cache at once unless `refresh` asks for a new explanation.
   */
  "code.explain": z.object({ scope: FileScope, path: FolderPath, text: z.string().max(explainLimits.characters), view: ExplanationView, refresh: z.boolean().optional() }).strict(),
};

/** Lines of the explained text, 1-based and inclusive. */
export interface LineSpan {
  start: number;
  end: number;
}

/** What a few lines of the file do, in everyday words: one statement, or a few lines doing one small thing. */
export interface LineNote {
  lines: LineSpan;
  text: string;
}

/** A line elsewhere in the folder that names something a block defines. */
export interface CodeUsage {
  path: FolderPath;
  line: number;
  text: string;
}

export interface WalkthroughBlock {
  lines: LineSpan;
  title: string;
  /** Markdown: what the block is for and why it exists, for someone who has never programmed. */
  explanation: string;
  /** The block's own lines explained in order, a step at a time. */
  steps: LineNote[];
  /** The names the block defines, which `usedBy` was found from. */
  symbols: string[];
  usedBy: CodeUsage[];
}

export const diagramNodeKinds = ["entry", "step", "decision", "data", "external", "output"] as const;
export type DiagramNodeKind = (typeof diagramNodeKinds)[number];

export interface DiagramNode {
  id: string;
  label: string;
  kind: DiagramNodeKind;
  /** One sentence, shown under the label. */
  summary: string;
  /** Markdown, shown when the node is opened. */
  detail: string;
  lines: LineSpan | null;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label: string | null;
}

export type CodeExplanation =
  /** Every statement of the file, top to bottom, said in everyday words. */
  { view: "english"; notes: LineNote[] } | { view: "walkthrough"; overview: string; blocks: WalkthroughBlock[] } | { view: "diagram"; summary: string; nodes: DiagramNode[]; edges: DiagramEdge[] };

export type CodeExplainResult =
  | { kind: "explained"; explanation: CodeExplanation; model: { provider: HarnessId; label: string }; createdAt: number }
  /** Explaining can't start: text generation is off or its agent signed out, both fixed in `settings`, or the file is empty or too long. */
  | { kind: "unavailable"; reason: string; settings: boolean }
  /** The model was asked and gave no usable answer. Asking again may work. */
  | { kind: "failed"; reason: string };

export interface CodeExplanationRpcResults {
  "code.explain": CodeExplainResult;
}
