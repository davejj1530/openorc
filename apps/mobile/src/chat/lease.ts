import type { TeamChatLease } from "@openorc/client";
import { useEffect, useMemo, useRef } from "react";
import { useSpaces } from "../spaces/use-spaces";

/** One generation per person and organization for the app's life, so every screen shares what the chat read. */
const generations = new Map<string, number>();
const generationOf = (scope: string): number => {
  const held = generations.get(scope) ?? generations.size + 1;
  generations.set(scope, held);
  return held;
};

/**
 * The lease on the shown organization's chat, held while Home shows it: `current()` false for whatever was read once
 * the person or the organization changes, and the same generation when they come back, so its chat shows again at
 * once. Null in Personal, which has no chat.
 */
export function useChatLease(): TeamChatLease | null {
  const spaces = useSpaces();
  const org = spaces.state === "ready" && spaces.current.kind === "organization" ? spaces : null;
  const scope = org ? JSON.stringify([org.userId, org.current.id]) : null;
  const shown = useRef(scope);
  useEffect(() => {
    shown.current = scope;
  }, [scope]);
  const reach = org?.offline ? "offline" : "live";
  const accountId = org?.userId;
  const spaceId = org?.current.id;
  return useMemo(
    () => (scope && accountId && spaceId ? { accountId, spaceId, generation: generationOf(scope), reach, current: () => shown.current === scope } : null),
    [scope, accountId, spaceId, reach],
  );
}
