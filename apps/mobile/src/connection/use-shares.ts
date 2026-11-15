import { useEffect, useState } from "react";
import { link, useSession } from "../client";

/**
 * Whether the shown Mac shares `capability`: null until its session says, false for an older Mac.
 * Asked again on each new session, as a Mac updated and reopened may share more.
 */
export function useShares(capability: string): boolean | null {
  const session = useSession();
  const [shared, setShared] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    link.connection.shares(capability).then(
      (answer) => live && setShared(answer),
      () => live && setShared(null),
    );
    return () => {
      live = false;
    };
  }, [session, capability]);
  return shared;
}
