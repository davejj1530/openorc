import type { Hosted } from "@openorc/hosted";
import type { Db } from "@openorc/db";
import type { HostedFiles } from "../services/hosted-files.js";
import { createHostedEnvironmentHandlers } from "./hosted-environment.js";
import { createHostedConnectorsHandlers } from "./hosted-connectors.js";
import { createHostedMachinesHandlers } from "./hosted-machines.js";
import { createHostedCheckHandlers } from "./hosted-check.js";
import { createHostedMacStartHandlers } from "./hosted-mac-start.js";
import { createHostedFilesHandlers } from "./hosted-files.js";
import { createHostedAccountHandlers } from "./organization-billing.js";
import { createOnlineTaskHandlers } from "./online-tasks.js";
import { createSpacesHandlers } from "./spaces.js";
import { createTeamChatHandlers } from "./team-chat.js";
import type { TeamChatOrclingCalls } from "../services/team-chat-orclings.js";

/** These account services belong to the Mac's windows; paired-phone methods retain their own allowlist. */
export function createHostedHandlers(account: Hosted | null, files: HostedFiles, db: Db, orclingCalls: TeamChatOrclingCalls) {
  return {
    ...createHostedAccountHandlers(account),
    ...createSpacesHandlers(account?.spaces ?? null),
    ...createTeamChatHandlers(account?.chat ?? null, orclingCalls),
    ...createOnlineTaskHandlers(account?.tasks ?? null),
    ...createHostedFilesHandlers(files),
    ...createHostedEnvironmentHandlers(account, db),
    ...createHostedConnectorsHandlers(account),
    ...createHostedMachinesHandlers(account),
    ...createHostedCheckHandlers(account),
    ...createHostedMacStartHandlers(account, db),
  };
}
