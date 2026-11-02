import type { CloudStatus } from "@openorc/protocol";
import type { ClaudeCloudTokens } from "../services/claude-cloud-tokens.js";
import type { CloudSettings } from "../services/cloud-settings.js";
import type { Handlers } from "./types.js";

type CloudMethod =
  | "cloud.status"
  | "cloud.vercel.connect"
  | "cloud.vercel.teams"
  | "cloud.vercel.team"
  | "cloud.vercel.disconnect"
  | "cloud.claude.create"
  | "cloud.claude.cancel"
  | "cloud.claude.save"
  | "cloud.claude.remove";

interface Dependencies {
  settings: CloudSettings;
  tokens: ClaudeCloudTokens;
  invalidate: (keys: string[]) => void;
}

export function createCloudHandlers({ settings, tokens, invalidate }: Dependencies): Pick<Handlers, CloudMethod> {
  const status = async (): Promise<CloudStatus> => {
    const vercel = await settings.status();
    try {
      return { ...vercel, claude: await tokens.status() };
    } catch (error) {
      return { ...vercel, claude: {}, error: vercel.error ?? (error instanceof Error ? error.message : String(error)) };
    }
  };
  /** Every change refreshes Settings and answers with the whole status. */
  const changed = async (work: () => Promise<unknown> | void): Promise<CloudStatus> => {
    await work();
    invalidate(["cloud"]);
    return status();
  };
  return {
    "cloud.status": status,
    "cloud.vercel.connect": async ({ token }) => {
      const { teams } = await settings.connect(token);
      return { status: await changed(() => undefined), teams };
    },
    "cloud.vercel.teams": () => settings.teams(),
    "cloud.vercel.team": ({ teamId }) => changed(() => settings.chooseTeam(teamId)),
    "cloud.vercel.disconnect": () => changed(() => settings.disconnect()),
    "cloud.claude.create": ({ accountId }) => changed(() => tokens.create(accountId)),
    "cloud.claude.cancel": ({ accountId }) => changed(() => tokens.cancel(accountId)),
    "cloud.claude.save": ({ accountId, token }) => changed(() => tokens.save(accountId, token)),
    "cloud.claude.remove": ({ accountId }) => changed(() => tokens.remove(accountId)),
  };
}
