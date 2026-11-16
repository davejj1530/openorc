import type { HostedMacProjectsRpcResults } from "@openorc/protocol";
import type { MacProjects } from "../services/mac-projects.js";
import type { Handlers } from "./types.js";

/** Personal projects from a folder of this Mac, and their threads' work brought back to it. */
export function createMacProjectsHandlers(mac: MacProjects): Pick<Handlers, keyof HostedMacProjectsRpcResults> {
  return {
    "macProjects.read": () => mac.read(),
    "macProjects.add": ({ localProjectId }) => mac.add(localProjectId),
    "macProjects.retry": ({ hostedProjectId }) => mac.retry(hostedProjectId),
    "macProjects.cancel": ({ hostedProjectId }) => mac.cancel(hostedProjectId),
    "macProjects.unbrought": ({ hostedProjectId }) => mac.unbrought(hostedProjectId),
    "macProjects.bringState": ({ spaceId, threadId }) => mac.bringState(spaceId, threadId),
    "macProjects.bring": ({ spaceId, threadId, endsOk }) => mac.bring(spaceId, threadId, endsOk),
  };
}
