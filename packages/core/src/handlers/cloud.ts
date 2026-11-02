import type { CloudStatus } from "@openorc/protocol";
import type { ClaudeCloudTokens } from "../services/claude-cloud-tokens.js";
import type { CloudChecks } from "../services/cloud-check.js";
import type { CodexCloudLogin } from "../services/codex-cloud-login.js";
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
  | "cloud.takeover"
  | "cloud.claude.create"
  | "cloud.claude.cancel"
  | "cloud.claude.save"
  | "cloud.claude.remove"
  | "cloud.codex.signIn"
  | "cloud.codex.cancel"
  | "cloud.codex.apiKey"
  | "cloud.codex.remove"
  | "cloud.check"
  | "cloud.sandboxes"
  | "cloud.offer"
  | "cloud.move"
  | "cloud.sandboxes.remove";

interface Dependencies {
  settings: CloudSettings;
  tokens: ClaudeCloudTokens;
  checks: CloudChecks;
  codex: CodexCloudLogin;
  sandboxes: CloudSandboxes;
  handoff: CloudHandoff;
  /** Cloud threads are offered in this build. */
  offered: boolean;
  invalidate: (keys: string[]) => void;
}

const noCodex = (error: string | null) => ({ mode: null, email: null, plan: null, refreshedAt: null, signingIn: false, error });

export function createCloudHandlers({ settings, tokens, checks, codex, sandboxes, handoff, offered, invalidate }: Dependencies): Pick<Handlers, CloudMethod> {
  const status = async (): Promise<CloudStatus> => {
    const vercel = await settings.status();
    const check = checks.status();
    const codexAccess = await codex.status().catch((error: unknown) => noCodex(error instanceof Error ? error.message : String(error)));
    try {
      return { ...vercel, claude: await tokens.status(), codex: codexAccess, check };
    } catch (error) {
      return { ...vercel, claude: {}, codex: codexAccess, check, error: vercel.error ?? (error instanceof Error ? error.message : String(error)) };
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
    "cloud.takeover": ({ enabled }) => changed(() => settings.setTakeover(enabled)),
    "cloud.claude.create": ({ accountId }) => changed(() => tokens.create(accountId)),
    "cloud.claude.cancel": ({ accountId }) => changed(() => tokens.cancel(accountId)),
    "cloud.claude.save": ({ accountId, token }) => changed(() => tokens.save(accountId, token)),
    "cloud.claude.remove": ({ accountId }) => changed(() => tokens.remove(accountId)),
    "cloud.codex.signIn": () => changed(() => codex.signIn()),
    "cloud.codex.cancel": () => changed(() => codex.cancel()),
    "cloud.codex.apiKey": ({ key }) => changed(() => codex.saveApiKey(key)),
    "cloud.codex.remove": () => changed(() => codex.remove()),
    "cloud.check": () => changed(() => checks.start()),
    "cloud.sandboxes": () => sandboxes.list(),
    "cloud.offer": async () => {
      if (!offered) return { offered: false, provider: null };
      return { offered: true, provider: (await settings.credentials()) ? "vercel" : "local" };
    },
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
