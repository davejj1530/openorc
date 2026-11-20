import { markLine, proofLabel, proofNames, proofOf, replyMarks, turnEvidence, type Block, type Proof } from "@openorc/client";

/**
 * What a reply's claim rests on, as the phone draws it: a pill at the end of the line that makes the claim, which
 * opens the edits or the run behind it. A check the reply says passed that the turn never ran says so, and opens nothing.
 */
export interface ReplyProof {
  /** The start of the line it stands on. */
  line: string;
  label: string;
  tone: "ok" | "bad" | "none";
  /** The run its calls belong to, when they name one. */
  runId: string | null;
  /** The calls behind it; none for a check the turn did not run. */
  calls: string[];
}

export const NO_PROOFS: ReplyProof[] = [];

function behind(proof: Proof): Block[] {
  switch (proof.kind) {
    case "file":
      return proof.edits.flatMap((edit) => edit.blocks);
    case "changes":
      return proof.files.flatMap((file) => file.edits.flatMap((edit) => edit.blocks));
    case "check":
      return proof.run.blocks;
    case "missing":
      return [];
  }
}

/** The proofs a finished turn's reply calls on, each with the line it stands on, in the order the reply calls on them. */
export function replyProofs(text: string, work: Block[]): ReplyProof[] {
  const evidence = turnEvidence(work);
  return replyMarks(text, proofNames(evidence)).flatMap((mark) => {
    const proof = proofOf(evidence, mark.key);
    if (!proof) return [];
    const blocks = behind(proof).filter((block) => block.kind === "tool");
    const { text: label, tone } = proofLabel(proof);
    return [{ line: mark.line, label, tone: tone ?? "none", runId: blocks.find((block) => block.runId)?.runId ?? null, calls: blocks.map((block) => block.id) }];
  });
}

/** Whether a piece of the reply holds the line a proof stands on. */
export const holdsProof = (piece: string, proof: ReplyProof): boolean => piece.split("\n").some((line) => markLine(line) === proof.line);

/** The address a pill's link carries: its tone, which styles it, and its place among the piece's proofs. */
const PROOF_URL = /^proof:(ok|bad|none):(\d+)$/;
export const PROOF_LINKS = { ok: "^proof:ok:", bad: "^proof:bad:", none: "^proof:none:" } as const;

/** A label as link text: its words kept in one piece, with a little room at each end of its ground. */
const pill = (label: string) => `\u00a0${label.replace(/[[\]\\]/g, "\\$&").replace(/ /g, "\u00a0")}\u00a0`;

/** The piece with each proof written at the end of the line it stands on, as a link the Markdown draws as a pill. */
export function withProofs(text: string, proofs: ReplyProof[]): string {
  if (!proofs.length) return text;
  const left = new Map(proofs.map((proof, index) => [proof, index]));
  return text
    .split("\n")
    .map((line) => {
      const here = [...left.keys()].filter((proof) => markLine(line) === proof.line);
      for (const proof of here) left.delete(proof);
      return here.reduce((written, proof) => `${written} [${pill(proof.label)}](proof:${proof.tone}:${proofs.indexOf(proof)})`, line);
    })
    .join("\n");
}

/** The proof a pressed link names, or null for any other link. */
export function proofAt(url: string, proofs: ReplyProof[]): ReplyProof | null {
  const named = PROOF_URL.exec(url);
  return named ? (proofs[Number(named[2])] ?? null) : null;
}
