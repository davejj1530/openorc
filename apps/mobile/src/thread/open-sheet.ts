import { lineCall, type ActLine } from "@openorc/client";
import { router } from "expo-router";
import { Keyboard } from "react-native";
import type { ReplyProof } from "./reply-proof";

/**
 * Opens what a line did in the sheet over the thread. The sheet reads the line's calls from the run, so one still
 * running fills in as it goes. The keyboard goes first, as it would cover the sheet's lower part.
 */
export function openLine({ object }: ActLine, runId: string) {
  const call = lineCall(object);
  if (!call) return;
  Keyboard.dismiss();
  const calls = object.blocks.flatMap((block) => (block.kind === "tool" ? [block.id] : [])).join(",");
  router.push({ pathname: "/tool", params: { runId: call.runId ?? runId, id: call.id, calls } });
}

/** Opens what a claim in the reply rests on: every edit or run behind its pill, in the same sheet. A check that never ran has nothing to open. */
export function openProof(proof: ReplyProof, runId: string) {
  const [first] = proof.calls;
  if (!first) return;
  Keyboard.dismiss();
  router.push({ pathname: "/tool", params: { runId: proof.runId ?? runId, id: first, calls: proof.calls.join(","), proof: "1" } });
}
