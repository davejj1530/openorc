import { rm } from "node:fs/promises";
import { alignAgents } from "./agent-versions.js";
import path from "node:path";
import {
  confirmSynced,
  copyHeads,
  openHandover,
  signInPrint,
  takeBranch,
  type BrainControlOp,
  type BrainControlRequest,
  type BrainControlResults,
  type BrainHandover,
  type BrainKey,
  type BrainLayout,
  type HandoverKind,
  type HandoverValues,
} from "@openorc/cloud";
import { markLeaving, type OpenOrc } from "@openorc/core";
import { claudeAccounts, projects, redact, threads } from "@openorc/db";
import type { Project } from "@openorc/protocol";
import type { BrainCloud } from "./cloud.js";
import type { BrainGitHub } from "./github.js";

export interface ControlContext {
  core: OpenOrc;
  key: BrainKey;
  layout: BrainLayout;
  github: BrainGitHub;
  cloud: Pick<BrainCloud, "take" | "print">;
  /** Closes the brain once the reply is on its way. */
  stop(): void;
  /** A control request is at work or waiting its turn. */
  answering(): boolean;
}

/** Every request but the status reads, which the host answers itself, starting and closing included. */
export type CoreOp = Exclude<BrainControlOp, "status" | "wake">;
type Handlers = { [K in CoreOp]: (request: Extract<BrainControlRequest, { op: K }>) => Promise<BrainControlResults[K]> };

/**
 * The brain's Claude accounts follow the Mac's list: each account in it is made or renamed under the Mac's id and signs
 * in with its token, and the Mac's default (else the first) is the brain's. Every other account loses its token.
 */
async function takeClaudeAccounts(core: OpenOrc, { accounts }: HandoverValues["claude"]): Promise<void> {
  const tokens = core.claudeCloudTokens;
  for (const { id, name, token } of accounts) {
    core.claudeAccounts.put({ id, name });
    if ((await tokens.token(id)) !== token) await tokens.save(id, token);
  }
  const chosen = accounts.find((account) => account.default) ?? accounts[0];
  if (chosen && core.claudeAccounts.defaultId() !== chosen.id) core.claudeAccounts.update({ id: chosen.id, makeDefault: true });
  const handed = new Set(accounts.map((account) => account.id));
  for (const { id } of claudeAccounts.list(core.db).filter((account) => !handed.has(account.id))) if (await tokens.token(id)) await tokens.remove(id);
  await retireSignedOut(core);
}

/**
 * On the brain an account signs in only with its cloud token, so one without a token is disabled, unless it is the
 * default; never deleted, since threads and runs keep naming it. One at work stays enabled until its sessions end, and
 * the brain runs this again every time it starts.
 */
export async function retireSignedOut(core: OpenOrc): Promise<void> {
  for (const account of claudeAccounts.list(core.db)) {
    if (!account.enabled || account.id === core.claudeAccounts.defaultId() || (await core.claudeCloudTokens.token(account.id))) continue;
    try {
      core.claudeAccounts.update({ id: account.id, enabled: false });
    } catch {
      // At work: the next start disables it.
    }
  }
}

type Take<K extends HandoverKind> = (context: TakeContext, value: HandoverValues[K]) => Promise<unknown>;
type TakeContext = Pick<ControlContext, "core" | "github" | "cloud">;

/** Where each handed-over sign-in goes on the brain: through the core service that owns it, as on the Mac. */
const HANDOVER: { [K in HandoverKind]: Take<K> } = {
  claude: ({ core }, value) => takeClaudeAccounts(core, value),
  // The brain's own login, made for it alone: from now on the brain refreshes it, as the Mac does its own.
  codex: ({ core }, login) => (login ? core.codexCloudLogin.adopt(login) : core.codexCloudLogin.remove()),
  github: ({ github }, value) => github.set(value),
  push: ({ core }, key) => (key ? core.remote.setPushKey(key.keyId, key.pem) : core.remote.removePushKey()),
  // Kept where the core keeps its own, sealed on the brain's disk; only its distilling reads it, never an agent.
  memory: ({ core }, value) => core.memory.takeApiKey(value?.apiKey ?? null),
  // Read by a cloud turn only for the provider of its model, and handed to that turn alone.
  opencode: ({ core }, value) => core.openCodeCloudKeys.adopt(value?.keys ?? []),
  // The core's sandbox services ask it at each use: threads started from now on run where it says.
  cloud: ({ cloud }, value) => cloud.take(value),
};
const HANDOVER_KINDS = Object.keys(HANDOVER) as HandoverKind[];

/** Applies one kind when the handover carries it. */
async function take<K extends HandoverKind>(kind: K, values: BrainHandover, context: TakeContext): Promise<boolean> {
  const value: HandoverValues[K] | undefined = values[kind];
  if (value === undefined) return false;
  await HANDOVER[kind](context, value);
  return true;
}

async function phonesOf(core: OpenOrc): Promise<BrainControlResults["phones"]> {
  return { phones: (await core.remote.status()).devices };
}

/** Every Mac project's copies, under a folder named for the Mac project's id. */
const projectsFolder = (layout: BrainLayout) => path.join(layout.data, "projects");
/** The copies of one Mac project: each in a folder with the Mac project's name, so two of one name both fit. */
const copiesOf = (layout: BrainLayout, source: string) => path.join(projectsFolder(layout), source);

/** Archived threads count too: they keep their history. */
const threadsIn = (core: OpenOrc, projectId: string) => threads.list(core.db, { projectId, filter: "all" }).length;

/** Through the core's own handlers, which tell the brain's phones the project list changed. */
async function rpc(core: OpenOrc, method: "projects.import" | "projects.remove", params: { rootPath: string } | { id: string }): Promise<unknown> {
  const reply = await core.handle({ type: "rpc", id: 0, method, params });
  if (reply.type === "rpc.error") throw new Error(reply.message);
  return reply.result;
}

async function importProject(
  core: OpenOrc,
  layout: BrainLayout,
  { source, name, branch, bundle, origin }: Extract<BrainControlRequest, { op: "import-project" }>,
): Promise<BrainControlResults["import-project"]> {
  const file = path.join(layout.inbox, bundle);
  try {
    const folder = path.join(copiesOf(layout, source), name);
    const taken = await takeBranch(folder, file, branch, origin ?? null);
    if ("lacksBase" in taken) return taken;
    const { id } = (await rpc(core, "projects.import", { rootPath: folder })) as Project;
    return { projectId: id, ...taken };
  } finally {
    await rm(file, { force: true });
  }
}

/** Each listed project in a Mac project's copy. A copy whose folder lost its git is left out, so the Mac sends it whole. */
async function listCopies(core: OpenOrc, layout: BrainLayout): Promise<BrainControlResults["projects"]> {
  const folder = `${projectsFolder(layout)}${path.sep}`;
  const copies = await Promise.all(
    core.projects
      .list()
      .filter((project) => project.rootPath.startsWith(folder))
      .map(async ({ id, rootPath }) => {
        const heads = await copyHeads(rootPath);
        return heads && { source: path.basename(path.dirname(rootPath)), projectId: id, ...heads, threads: threadsIn(core, id) };
      }),
  );
  return { copies: copies.filter((copy) => copy !== null) };
}

/** Each copy the Mac found current counts as synced now, unless it took another commit of the Mac's since. */
async function copiesCurrent(core: OpenOrc, layout: BrainLayout, { copies }: Extract<BrainControlRequest, { op: "copies-current" }>): Promise<BrainControlResults["copies-current"]> {
  let marked = 0;
  for (const { source, macHead } of copies) {
    const id = copyOf(core, layout, source);
    const root = id ? projects.get(core.db, id)?.rootPath : null;
    if (root && (await confirmSynced(root, macHead))) marked++;
  }
  return { marked };
}

/** A Mac project's copy goes, unlisted as the core removes a project, only while the brain has no thread in it. */
async function removeProject(core: OpenOrc, layout: BrainLayout, { source }: Extract<BrainControlRequest, { op: "remove-project" }>): Promise<BrainControlResults["remove-project"]> {
  const folder = copiesOf(layout, source);
  const copies = projects.list(core.db, { includeRemoved: true }).filter((project) => project.rootPath.startsWith(`${folder}${path.sep}`));
  const count = copies.reduce((sum, project) => sum + threadsIn(core, project.id), 0);
  if (count) return { removed: false, threads: count };
  for (const { id } of copies) await rpc(core, "projects.remove", { id });
  await rm(folder, { recursive: true, force: true });
  return { removed: true, threads: 0 };
}

/** The brain's copy of a Mac project, by the Mac project's id. */
function copyOf(core: OpenOrc, layout: BrainLayout, source: string): string | null {
  const folder = `${copiesOf(layout, source)}${path.sep}`;
  return core.projects.list().find((project) => project.rootPath.startsWith(folder))?.id ?? null;
}

/** The Mac project a copy belongs to, from the folder it lives in. */
function sourceOf(core: OpenOrc, layout: BrainLayout, projectId: string): string | null {
  const root = projects.get(core.db, projectId)?.rootPath;
  return root?.startsWith(`${projectsFolder(layout)}${path.sep}`) ? path.basename(path.dirname(root)) : null;
}

/** A thread's move between its Mac and the brain, onto the core's relocations. A package taken leaves the inbox. */
function relocationHandlers(core: OpenOrc, layout: BrainLayout): Pick<Handlers, "identity" | "receive-thread" | "drop-arrival" | "hand-off-thread" | "cancel-hand-off" | "handed-off"> {
  return {
    identity: async () => ({ linkKey: await core.remote.linkKey() }),
    "receive-thread": async ({ relocation, package: file }) => {
      const inbox = path.join(layout.inbox, file);
      try {
        return await core.relocations.receive(relocation, inbox, (source) => copyOf(core, layout, source));
      } finally {
        await rm(inbox, { force: true });
      }
    },
    "drop-arrival": async ({ relocation, threadId }) => core.relocations.dropArrival(relocation, threadId),
    "hand-off-thread": ({ relocation, threadId }) => core.relocations.handOff(relocation, threadId, layout.outbox, (projectId) => sourceOf(core, layout, projectId)),
    "cancel-hand-off": ({ relocation, threadId }) => core.relocations.cancelHandOff(relocation, threadId, layout.outbox),
    "handed-off": ({ relocation }) => core.relocations.handedOff(relocation, layout.outbox),
  };
}

/** Each control request onto services the core already has. Handed-over values are never logged or repeated. */
export function controlHandlers({ core, key, layout, github, cloud, stop, answering }: ControlContext): (request: Extract<BrainControlRequest, { op: CoreOp }>) => Promise<unknown> {
  const handlers: Handlers = {
    pair: async () => {
      const { url, expiresAt } = await core.remote.beginPairing();
      return { url, expiresAt };
    },
    handover: async (request) => {
      const values = openHandover(key, request);
      const applied: HandoverKind[] = [];
      for (const kind of HANDOVER_KINDS) if (await take(kind, values, { core, github, cloud })) applied.push(kind);
      return { applied };
    },
    "import-project": (request) => importProject(core, layout, request),
    "remove-project": (request) => removeProject(core, layout, request),
    projects: () => listCopies(core, layout),
    "copies-current": (request) => copiesCurrent(core, layout, request),
    "agent-versions": ({ versions }) => alignAgents(layout.npm, versions),
    leaving: async ({ until }) => {
      markLeaving(core.db, until);
      return { until };
    },
    "project-settings": async ({ source, settings }) => {
      const id = copyOf(core, layout, source);
      if (id) core.projects.updateSettings(id, settings);
      return { applied: id !== null };
    },
    phones: () => phonesOf(core),
    "remove-phone": async ({ id }) => {
      core.remote.removeDevice(id);
      return phonesOf(core);
    },
    "sign-ins": async () => {
      const apiKey = await core.memory.apiKey();
      const keys = (await core.openCodeCloudKeys.all()).sort((a, b) => (a.provider < b.provider ? -1 : 1));
      return {
        codex: await core.codexCloudLogin.heldId(),
        github: github.print(),
        push: (await core.remote.status()).push.keyId,
        memory: apiKey && signInPrint({ apiKey }),
        opencode: keys.length ? signInPrint({ keys }) : null,
        cloud: cloud.print(),
      };
    },
    stop: async () => {
      setImmediate(stop);
      return { stopping: true };
    },
    "stop-for-update": async () => {
      // The desktop's own check before it restarts to update: it fences new turns in the same step, so none starts
      // between the check and the close.
      const refusal = answering() ? "The cloud brain is answering another request." : core.prepareForUpdate();
      if (refusal) throw new Error(refusal);
      setImmediate(stop);
      return { stopping: true };
    },
    ...relocationHandlers(core, layout),
  };
  return async (request) => {
    try {
      return await (handlers[request.op] as (request: BrainControlRequest) => Promise<unknown>)(request);
    } catch (error) {
      throw new Error(redact(error instanceof Error ? error.message : String(error)).text);
    }
  };
}
