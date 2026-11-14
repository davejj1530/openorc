import type { Hosted } from "@openorc/hosted";
import type { HostedFiles } from "../services/hosted-files.js";
import { createHostedFilesHandlers } from "./hosted-files.js";
import { createHostedAccountHandlers } from "./organization-billing.js";
import { createOnlineTaskHandlers } from "./online-tasks.js";
import { createSpacesHandlers } from "./spaces.js";
import { createTeamChatHandlers } from "./team-chat.js";

/** These account services belong to the Mac's windows; paired-phone methods retain their own allowlist. */
export function createHostedHandlers(account: Hosted | null, files: HostedFiles) {
  return {
    ...createHostedAccountHandlers(account),
    ...createSpacesHandlers(account?.spaces ?? null),
    ...createTeamChatHandlers(account?.chat ?? null),
    ...createOnlineTaskHandlers(account?.tasks ?? null),
    ...createHostedFilesHandlers(files),
  };
}
