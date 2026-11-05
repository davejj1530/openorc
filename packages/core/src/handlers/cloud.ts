import type { CloudStatus } from "@openorc/protocol";
import type { ClaudeCloudTokens } from "../services/claude-cloud-tokens.js";
import type { CloudBrain } from "../services/cloud-brain.js";
import type { CloudChecks } from "../services/cloud-check.js";
import type { CodexCloudLogin } from "../services/codex-cloud-login.js";
import type { OpenCodeCloudKeys } from "../services/cloud-opencode.js";
import type { CloudHandoff } from "../services/cloud-handoff.js";
import type { CloudSandboxes } from "../services/cloud-sandboxes.js";
import type { CloudSettings } from "../services/cloud-settings.js";
import type { RelocationCoordinator } from "../services/relocation-coordinator.js";
import type { Handlers } from "./types.js";

type CloudMethod =
  | "cloud.status"
  | "cloud.vercel.connect"
  | "cloud.vercel.teams"
  | "cloud.vercel.team"
  | "cloud.vercel.disconnect"
  | "cloud.vercel.size"
  | "cloud.vercel.region"
  | "cloud.agent37.connect"
  | "cloud.agent37.disconnect"
  | "cloud.agent37.size"
  | "cloud.service"
  | "cloud.takeover"
  | "cloud.claude.create"
  | "cloud.claude.cancel"
  | "cloud.claude.save"
  | "cloud.claude.remove"
  | "cloud.codex.signIn"
  | "cloud.codex.cancel"
  | "cloud.codex.apiKey"
  | "cloud.codex.remove"
  | "cloud.opencode.saveKey"
  | "cloud.opencode.removeKey"
  | "cloud.check"
  | "cloud.sandboxes"
  | "cloud.offer"
  | "cloud.move"
  | "cloud.bringToMac"
  | "cloud.keep"
  | "cloud.sandboxes.remove"
  | "cloud.brain.status"
  | "cloud.brain.create"
  | "cloud.brain.wake"
  | "cloud.brain.pair"
  | "cloud.brain.handover"
  | "cloud.brain.remove"
  | "cloud.brain.recount"
  | "cloud.brain.projects"
  | "cloud.brain.cost"
  | "cloud.brain.project"
  | "cloud.brain.signIns"
  | "cloud.brain.codex.signIn"
  | "cloud.brain.codex.cancel"
  | "cloud.brain.codex.apiKey"
  | "cloud.brain.codex.remove"
  | "cloud.brain.github"
  | "cloud.brain.phones"
  | "cloud.brain.phones.remove";

interface Dependencies {
  settings: CloudSettings;
  tokens: ClaudeCloudTokens;
  checks: CloudChecks;
  codex: CodexCloudLogin;
  opencode: Pick<OpenCodeCloudKeys, "providers" | "save" | "remove">;
  sandboxes: CloudSandboxes;
  handoff: CloudHandoff;
  brain: CloudBrain;
  /** Moves threads to the cloud brain and back; null on the brain itself. */
  coordinator: RelocationCoordinator | null;
  /** Cloud threads are offered in this build. */
  offered: boolean;
  invalidate: (keys: string[]) => void;
  /** After the brain was removed, with the key phones know it by: what this Mac kept of it goes. */
  removed: (linkKey: string | null) => Promise<void>;
}

const noCodex = (error: string | null) => ({ mode: null, email: null, plan: null, refreshedAt: null, signingIn: false, error });

/** Once the brain is gone, what this Mac kept of it goes too, named by the key its phones know it by. */
async function removeBrain(brain: CloudBrain, removed: Dependencies["removed"]): Promise<void> {
  const linkKey = (await brain.moves())?.linkKey ?? null;
  await brain.remove();
  if (!(await brain.exists())) await removed(linkKey);
}

export function createCloudHandlers({ settings, tokens, checks, codex, opencode, sandboxes, handoff, brain, coordinator, offered, invalidate, removed }: Dependencies): Pick<Handlers, CloudMethod> {
  const status = async (): Promise<CloudStatus> => {
    const vercel = await settings.status();
    const check = checks.status();
    const codexAccess = await codex.status().catch((error: unknown) => noCodex(error instanceof Error ? error.message : String(error)));
    try {
      return { ...vercel, claude: await tokens.status(), codex: codexAccess, opencode: { providers: await opencode.providers() }, check };
    } catch (error) {
      return { ...vercel, claude: {}, codex: codexAccess, opencode: { providers: [] }, check, error: vercel.error ?? (error instanceof Error ? error.message : String(error)) };
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
      brain.vercelChanged();
      return { status: await changed(() => undefined), teams };
    },
    "cloud.vercel.teams": () => settings.teams(),
    "cloud.vercel.team": ({ teamId }) => changed(() => settings.chooseTeam(teamId).then(() => brain.vercelChanged())),
    // The brain's door holds a copy of the token: it goes first, or the connection stays.
    "cloud.vercel.disconnect": () => changed(() => brain.disconnect(() => settings.disconnect())),
    "cloud.vercel.size": ({ vcpus }) => changed(() => settings.chooseSize(vcpus).then(() => brain.vercelChanged())),
    "cloud.vercel.region": ({ region }) => changed(() => settings.chooseRegion(region)),
    "cloud.agent37.connect": ({ key }) => changed(() => settings.connectAgent37(key)),
    "cloud.agent37.disconnect": () => changed(() => settings.disconnectAgent37()),
    "cloud.agent37.size": ({ size }) => changed(() => settings.chooseAgent37Size(size)),
    "cloud.service": ({ service }) => changed(() => settings.chooseService(service)),
    "cloud.takeover": ({ enabled }) => changed(() => settings.setTakeover(enabled)),
    "cloud.claude.create": ({ accountId }) => changed(() => tokens.create(accountId)),
    "cloud.claude.cancel": ({ accountId }) => changed(() => tokens.cancel(accountId)),
    "cloud.claude.save": ({ accountId, token }) => changed(() => tokens.save(accountId, token)),
    "cloud.claude.remove": ({ accountId }) => changed(() => tokens.remove(accountId)),
    "cloud.codex.signIn": () => changed(() => codex.signIn()),
    "cloud.codex.cancel": () => changed(() => codex.cancel()),
    "cloud.codex.apiKey": ({ key }) => changed(() => codex.saveApiKey(key)),
    "cloud.codex.remove": () => changed(() => codex.remove()),
    "cloud.opencode.saveKey": ({ provider, key }) => changed(() => opencode.save(provider, key)),
    "cloud.opencode.removeKey": ({ provider }) => changed(() => opencode.remove(provider)),
    "cloud.check": () => changed(() => checks.start()),
    "cloud.sandboxes": () => sandboxes.list(),
    "cloud.offer": async () => {
      if (!offered) return { offered: false, provider: null };
      const moves = await brain.moves();
      const projects = (moves?.projects ?? []).flatMap((copy) => (copy.brainId ? [{ mac: copy.id, cloud: copy.brainId }] : []));
      return { offered: true, provider: (await settings.service()) ?? "local", brain: moves ? { host: moves.linkKey, projects } : null };
    },
    // With a cloud brain set up, the brain takes the thread; without one, it moves to a sandbox driven from this Mac.
    "cloud.move": async ({ threadId }) => {
      const thread = coordinator && (await coordinator.ready()) ? await coordinator.toCloud(threadId) : await handoff.move(threadId);
      invalidate(["threads", `thread:${threadId}`, "cloud"]);
      return thread;
    },
    "cloud.bringToMac": ({ threadId }) => {
      if (!coordinator) throw new Error("Only the Mac brings conversations home.");
      coordinator.bringToMac(threadId);
      return null;
    },
    "cloud.keep": async ({ threadId }) => {
      await coordinator?.cancel(threadId);
      invalidate(["threads", `thread:${threadId}`]);
      return null;
    },
    "cloud.sandboxes.remove": async ({ name }) => {
      await sandboxes.remove(name);
      invalidate(["cloud"]);
      return sandboxes.list();
    },
    ...brainHandlers(brain, removed),
    ...brainSignInHandlers(brain),
  };
}

type SignInMethod = Extract<CloudMethod, "cloud.brain.signIns" | `cloud.brain.codex.${string}` | "cloud.brain.github">;

/** The brain itself: setting it up, waking it, its projects, its cost and the phones paired with it. */
function brainHandlers(brain: CloudBrain, removed: Dependencies["removed"]): Pick<Handlers, Exclude<Extract<CloudMethod, `cloud.brain.${string}`>, SignInMethod>> {
  return {
    "cloud.brain.status": () => brain.status(),
    "cloud.brain.create": async ({ region }) => {
      await brain.create(region);
      return brain.status();
    },
    "cloud.brain.wake": async () => {
      await brain.wake();
      return brain.status();
    },
    "cloud.brain.pair": () => brain.pair(),
    "cloud.brain.handover": async () => {
      await brain.handover();
      return brain.status();
    },
    "cloud.brain.remove": async () => {
      await removeBrain(brain, removed);
      return brain.status();
    },
    "cloud.brain.recount": async () => {
      await brain.recount();
      return brain.status();
    },
    "cloud.brain.projects": () => brain.projects(),
    "cloud.brain.cost": () => brain.cost(),
    "cloud.brain.project": async ({ projectId, on }) => {
      await brain.setProject(projectId, on);
      return brain.projects();
    },
    "cloud.brain.phones": () => brain.phones.list(),
    // A failure shows in the brain's status, as the card's other operations' do.
    "cloud.brain.phones.remove": ({ id }) => brain.phones.remove(id).catch(() => brain.phones.list()),
  };
}

/** What the brain signs in with besides Claude; every change answers with the whole of it. */
function brainSignInHandlers(brain: CloudBrain): Pick<Handlers, SignInMethod> {
  const changed = async (work: () => Promise<unknown> | void) => {
    await work();
    return brain.signIns();
  };
  return {
    "cloud.brain.signIns": () => brain.signIns(),
    "cloud.brain.codex.signIn": () => changed(() => brain.codexSignIn()),
    "cloud.brain.codex.cancel": () => changed(() => brain.codexCancel()),
    "cloud.brain.codex.apiKey": ({ key }) => changed(() => brain.codexApiKey(key)),
    "cloud.brain.codex.remove": () => changed(() => brain.codexRemove()),
    "cloud.brain.github": ({ on }) => changed(() => brain.setGitHub(on)),
  };
}
