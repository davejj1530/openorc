import type { CloudStatus } from "@openorc/protocol";
import type { ClaudeCloudTokens } from "../services/claude-cloud-tokens.js";
import type { CloudChecks } from "../services/cloud-check.js";
import type { CloudHandoff } from "../services/cloud-handoff.js";
import type { CloudSandboxes } from "../services/cloud-sandboxes.js";
import type { CloudSettings } from "../services/cloud-settings.js";
import type { Handlers } from "./types.js";

type CloudMethod =
  | "cloud.status"
  | "cloud.vercel.connect"
  | "cloud.vercel.teams"
  | "cloud.vercel.team"
  | "cloud.vercel.disconnect"
  | "cloud.vercel.size"
  | "cloud.claude.create"
  | "cloud.claude.cancel"
  | "cloud.claude.save"
  | "cloud.claude.remove"
  | "cloud.check"
  | "cloud.sandboxes"
  | "cloud.move"
  | "cloud.sandboxes.remove";

interface Dependencies {
  settings: CloudSettings;
  tokens: ClaudeCloudTokens;
  checks: CloudChecks;
  sandboxes: CloudSandboxes;
  handoff: CloudHandoff;
  invalidate: (keys: string[]) => void;
}

export function createCloudHandlers({ settings, tokens, checks, sandboxes, handoff, invalidate }: Dependencies): Pick<Handlers, CloudMethod> {
  const status = async (): Promise<CloudStatus> => {
    const vercel = await settings.status();
    const check = checks.status();
    try {
      return { ...vercel, claude: await tokens.status(), check };
    } catch (error) {
      return { ...vercel, claude: {}, check, error: vercel.error ?? (error instanceof Error ? error.message : String(error)) };
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
    "cloud.vercel.size": ({ vcpus }) => changed(() => settings.chooseSize(vcpus)),
    "cloud.claude.create": ({ accountId }) => changed(() => tokens.create(accountId)),
    "cloud.claude.cancel": ({ accountId }) => changed(() => tokens.cancel(accountId)),
    "cloud.claude.save": ({ accountId, token }) => changed(() => tokens.save(accountId, token)),
    "cloud.claude.remove": ({ accountId }) => changed(() => tokens.remove(accountId)),
    "cloud.check": () => changed(() => checks.start()),
    "cloud.sandboxes": () => sandboxes.list(),
    "cloud.move": async ({ threadId }) => {
      const thread = await handoff.move(threadId);
      invalidate(["threads", `thread:${threadId}`, "cloud"]);
      return thread;
    },
    "cloud.sandboxes.remove": async ({ name }) => {
      await sandboxes.remove(name);
      invalidate(["cloud"]);
      return sandboxes.list();
    },
  };
}
