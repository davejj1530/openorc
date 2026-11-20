import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { citationLinks, proofLabel, proofNames, proofOf, replyMarks, turnEvidence, type Block, type Proof, type TurnEvidence, actLines, type ActLine } from "@openorc/client";
import { Check, CircleDashed, X } from "./icons";
import { PROOF_LINE, PROOF_MARK, proofLines } from "../lib/proof-lines";
import type { TextMarks } from "./ThreadImages";
import { ActGroup } from "./WorkActs";
import type { RenderBlocks } from "./WorkMarks";
import "./ReplyProof.css";

/**
 * Proof beside claims. A sentence of a turn's reply that says what the turn did ends in a mark for what backs it: the
 * edit, the test run. Pressing the mark opens that work right under the sentence, as its line in the turn's activity.
 * A check the reply says passed that the turn never ran says so instead.
 */

interface TurnProofs {
  evidence: TurnEvidence;
  renderBlocks: RenderBlocks;
}

const TurnProofContext = createContext<TurnProofs | null>(null);

/** Around a turn's reply: what the turn did, for the reply's sentences to call on. A turn still running proves nothing yet. */
export function TurnProof({ work, live, renderBlocks, children }: { work: Block[]; live: boolean; renderBlocks: RenderBlocks; children: ReactNode }) {
  const evidence = useMemo(() => (live ? null : turnEvidence(work)), [work, live]);
  return <TurnProofContext.Provider value={evidence && { evidence, renderBlocks }}>{children}</TurnProofContext.Provider>;
}

const components: TextMarks["components"] = { [PROOF_LINE]: ProofLine, [PROOF_MARK]: ProofMark };

/** The marks a reply's text takes from its turn, for the text's renderer; none while the reply is still being written. */
export function useReplyProof(text: string, streaming: boolean): TextMarks | undefined {
  const evidence = useContext(TurnProofContext)?.evidence;
  return useMemo(() => {
    if (!evidence || streaming) return undefined;
    const names = proofNames(evidence);
    // The lines are found again in the text as the renderer gets it.
    const marks = replyMarks(citationLinks(text), names);
    return marks.length ? { steps: [[proofLines, { marks, names }]], components } : undefined;
  }, [evidence, text, streaming]);
}

/** The lines of the turn's activity a proof stands for. */
function proofActs(proof: Proof): ActLine[] {
  if (proof.kind === "file") return actLines(proof.edits);
  if (proof.kind === "changes") return proof.files.flatMap((file) => actLines(file.edits));
  return proof.kind === "check" ? actLines([proof.run]) : [];
}

/** Which of a sentence's proofs is open, and the way to open another. */
const ProofLineContext = createContext<{ open: string | null; toggle: (key: string) => void } | null>(null);

/** A sentence with its marks, and under it whichever of them is open. */
function ProofLine(props: Record<string, unknown>) {
  const children = props["children"] as ReactNode;
  const turn = useContext(TurnProofContext);
  const [open, setOpen] = useState<string | null>(null);
  // The one last opened stays drawn while it folds.
  const [shown, setShown] = useState<string | null>(null);
  if (open && open !== shown) setShown(open);
  const line = useMemo(() => ({ open, toggle: (key: string) => setOpen((now) => (now === key ? null : key)) }), [open]);
  const proof = turn && shown ? proofOf(turn.evidence, shown) : null;
  const acts = proof ? proofActs(proof) : [];
  return (
    <ProofLineContext.Provider value={line}>
      {children}
      <div hidden={!open} className="proof-body motion-collapse">
        {turn && acts.length ? <ActGroup key={shown} group={acts} current={acts.length === 1} renderBlocks={turn.renderBlocks} /> : null}
      </div>
    </ProofLineContext.Provider>
  );
}

/** A proof that holds, and one that failed; one that cannot tell keeps the open ring. */
const MARKS = { ok: Check, bad: X };

/** What backs a sentence, in a few words at its end. Pressing it opens that work under the sentence. */
function ProofMark(props: Record<string, unknown>) {
  const key = typeof props["data-proof"] === "string" ? props["data-proof"] : "";
  const turn = useContext(TurnProofContext);
  const line = useContext(ProofLineContext);
  const proof = turn ? proofOf(turn.evidence, key) : null;
  if (!proof || !line) return null;
  const { text, tone } = proofLabel(proof);
  if (proof.kind === "missing")
    return (
      <span className="proof-none">
        <CircleDashed size={13} />
        {text}
      </span>
    );
  const Mark = tone ? MARKS[tone] : CircleDashed;
  return (
    <button type="button" className="proof-chip" data-tone={tone ?? undefined} aria-expanded={line.open === key} onClick={() => line.toggle(key)}>
      <Mark size={13} />
      {text}
    </button>
  );
}
