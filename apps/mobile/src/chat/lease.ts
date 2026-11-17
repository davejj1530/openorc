import type { TeamChatLease } from "@openorc/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSpaces } from "../spaces/use-spaces";

/**
 * The lease on the shown organization's chat, held while Home shows it: a new generation once the person or the
 * organization changes, and `current()` false for whatever was read before. Null in Personal, which has no chat.
 */
export function useChatLease(): TeamChatLease | null {
  const spaces = useSpaces();
  const org = spaces.state === "ready" && spaces.current.kind === "organization" ? spaces : null;
  const scope = org ? JSON.stringify([org.userId, org.current.id]) : null;
  const [held, setHeld] = useState({ scope, generation: 1 });
  if (held.scope !== scope) setHeld({ scope, generation: held.generation + 1 });
  const shown = useRef(scope);
  useEffect(() => {
    shown.current = scope;
  }, [scope]);
  const reach = org?.offline ? "offline" : "live";
  const accountId = org?.userId;
  const spaceId = org?.current.id;
  return useMemo(
    () => (scope && accountId && spaceId ? { accountId, spaceId, generation: held.generation, reach, current: () => shown.current === scope } : null),
    [scope, accountId, spaceId, held.generation, reach],
  );
}
