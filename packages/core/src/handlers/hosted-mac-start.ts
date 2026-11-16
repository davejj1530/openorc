import type { Hosted } from "@openorc/hosted";
import type { Db } from "@openorc/db";
import type { HostedMacStartRpcResults } from "@openorc/protocol";
import { packProject, planOf } from "../services/mac-work.js";
import type { Handlers } from "./types.js";

/** What a cloud thread started from this Mac's project folder would carry, read before anything leaves. */
export function createHostedMacStartHandlers(account: Hosted | null, db: Db): Pick<Handlers, keyof HostedMacStartRpcResults> {
  return {
    "hostedMacStart.plan": async ({ projectId, spaceId, include }) =>
      (await account?.threads.macStartOffered?.(projectId, spaceId)) ? planOf(await packProject(db, projectId, include)) : { state: "unavailable" },
  };
}
