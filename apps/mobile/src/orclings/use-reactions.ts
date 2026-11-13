import type { MessageReaction, Reaction } from "@openorc/protocol";
import { useEffect, useMemo, useState } from "react";
import { useRpc, useRpcMutation } from "../client";

/** One bubble of one message: tapbacks land on bubbles, as `chatBubbles` splits a message. */
export const reactionKey = (runId: string | undefined, messageId: string, part: number) => `${runId ?? ""}|${messageId}|${part}`;

/**
 * The conversation's tapbacks by bubble. The person's own show the moment they choose, ahead of the Mac's copy, which
 * takes over once it agrees, as on the Mac. Tapbacks travel as their own reads, never as a run's events.
 */
export function useReactions(threadId: string) {
  const list = useRpc("orclings.reactions", { threadId }).data;
  const react = useRpcMutation("orclings.react");
  const [chosen, setChosen] = useState<ReadonlyMap<string, Reaction | null>>(new Map());
  const byKey = useMemo(() => {
    const map = new Map<string, MessageReaction[]>();
    for (const reaction of list ?? []) {
      const key = reactionKey(reaction.runId, reaction.messageId, reaction.part);
      map.set(key, [...(map.get(key) ?? []), reaction]);
    }
    return map;
  }, [list]);
  const recorded = (key: string) => byKey.get(key)?.find((reaction) => reaction.orclingId === null)?.reaction ?? null;
  // A choice gives way once the Mac's list agrees with it.
  useEffect(() => {
    setChosen((current) => {
      const waiting = [...current].filter(([key, reaction]) => (byKey.get(key)?.find((other) => other.orclingId === null)?.reaction ?? null) !== reaction);
      return waiting.length === current.size ? current : new Map(waiting);
    });
  }, [byKey]);
  return {
    /** The person's tapback on a bubble of the Orcling's. */
    person: (key: string): Reaction | undefined => (chosen.has(key) ? (chosen.get(key) ?? undefined) : (recorded(key) ?? undefined)),
    /** The Orcling's tapback on a message of the person's. */
    orcling: (key: string): Reaction | undefined => byKey.get(key)?.find((reaction) => reaction.orclingId !== null)?.reaction,
    /** Sets the person's tapback, or with null takes it back. */
    choose: (target: { runId: string; messageId: string; part: number }, reaction: Reaction | null) => {
      setChosen((current) => new Map(current).set(reactionKey(target.runId, target.messageId, target.part), reaction));
      react.mutate({ threadId, ...target, reaction });
    },
  };
}
