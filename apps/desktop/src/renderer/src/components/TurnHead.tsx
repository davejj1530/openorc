import { turnShowsSender } from "@openorc/client";
import { harnessShortName, isHarnessId } from "@openorc/protocol";
import { useRunVoice, useTurnAuthor } from "../lib/turn-authors";
import { HarnessLogo } from "./HarnessLogo";
import { useMessageAuthor, useTurnSender } from "../lib/thread-authors";
import { TurnSender } from "./ThreadVoice";

/**
 * A turn's head, only where it has something to say: the agent's mark and name where who speaks changed from the
 * turn before (`voiced`), and in a cloud thread others are in, who sent the turn where its prompt does not already
 * name them. It never names the model, which the composer shows. `blocks`: the turn's, which name its sender;
 * `prompt`: the message the turn answers.
 */
export function TurnHead({
  runId,
  named,
  voiced,
  live,
  blocks,
  prompt,
}: {
  runId: string;
  named?: string | undefined;
  voiced: boolean;
  live: boolean;
  blocks?: readonly { id: string }[];
  prompt?: string | undefined;
}) {
  const author = useTurnAuthor(named, runId);
  const voice = useRunVoice(runId);
  const sender = useTurnSender(blocks, live);
  const sent = turnShowsSender(sender, useMessageAuthor(prompt)) ? sender : undefined;
  if (!voiced && sent === undefined) return null;
  return (
    <div className="turn-head">
      {voiced && voice && isHarnessId(voice.agent) ? <HarnessLogo id={voice.agent} size={14} className="turn-head-mark" /> : null}
      {voiced ? <span className="turn-head-name">{author ?? (voice ? harnessShortName(voice.agent) : "Assistant")}</span> : null}
      {sent !== undefined ? <TurnSender person={sent} /> : null}
    </div>
  );
}
