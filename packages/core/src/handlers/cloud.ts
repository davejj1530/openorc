import type { CloudSettings } from "../services/cloud-settings.js";
import type { Handlers } from "./types.js";

type CloudMethod = "cloud.status" | "cloud.vercel.connect" | "cloud.vercel.teams" | "cloud.vercel.team" | "cloud.vercel.disconnect" | "cloud.claude.save" | "cloud.claude.remove";

export function createCloudHandlers({ settings, invalidate }: { settings: CloudSettings; invalidate: (keys: string[]) => void }): Pick<Handlers, CloudMethod> {
  const changed = async <T>(work: Promise<T>): Promise<T> => {
    const result = await work;
    invalidate(["cloud"]);
    return result;
  };
  return {
    "cloud.status": () => settings.status(),
    "cloud.vercel.connect": ({ token }) => changed(settings.connect(token)),
    "cloud.vercel.teams": () => settings.teams(),
    "cloud.vercel.team": ({ teamId }) => changed(settings.chooseTeam(teamId)),
    "cloud.vercel.disconnect": () => changed(settings.disconnect()),
    "cloud.claude.save": ({ token }) => changed(settings.saveClaudeToken(token)),
    "cloud.claude.remove": () => changed(settings.removeClaudeToken()),
  };
}
