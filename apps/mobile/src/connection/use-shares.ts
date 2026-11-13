import { useContext, useEffect, useState } from "react";
import { hostLink, useSession } from "../client";
import { HostContext } from "./host-context";

/**
 * Whether the host this screen talks to shares `capability`: null until its session says, false for an older Mac.
 * Asked again on each new session, as a Mac updated and reopened may share more.
 */
export function useShares(capability: string): boolean | null {
  const host = useContext(HostContext);
  const session = useSession();
  const [shared, setShared] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    hostLink(host)
      .connection.shares(capability)
      .then(
        (answer) => live && setShared(answer),
        () => live && setShared(null),
      );
    return () => {
      live = false;
    };
  }, [host, session, capability]);
  return shared;
}
