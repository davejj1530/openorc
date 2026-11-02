import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { openHandover, type BrainControlOp, type BrainControlRequest, type BrainControlResults, type BrainKey, type BrainLayout, type HandoverKind, type HandoverValues } from "@openorc/cloud";
import type { OpenOrc } from "@openorc/core";
import { claudeAccounts, redact } from "@openorc/db";
import { git } from "@openorc/git";
import type { Project } from "@openorc/protocol";

export interface ControlContext {
  core: OpenOrc;
  key: BrainKey;
  layout: BrainLayout;
  /** Closes the brain once the reply is on its way. */
  stop(): void;
}

/** Every request but status, which the host answers itself, starting and closing included. */
export type CoreOp = Exclude<BrainControlOp, "status">;
type Handlers = { [K in CoreOp]: (request: Extract<BrainControlRequest, { op: K }>) => Promise<BrainControlResults[K]> };

/** Where each handed-over sign-in goes on the brain: through the core service that owns it, as on the Mac. Null: not taken. */
const HANDOVER: { [K in HandoverKind]: ((core: OpenOrc, value: HandoverValues[K]) => Promise<unknown>) | null } = {
  claude: (core, { token }) => core.claudeCloudTokens.save(claudeAccounts.defaultId(core.db), token),
  // A ChatGPT login's refresh token works once, so the brain and the Mac cannot both keep one; which does is open.
  codex: null,
  push: (core, { keyId, pem }) => core.remote.setPushKey(keyId, pem),
};
const HANDOVER_KINDS = Object.keys(HANDOVER) as HandoverKind[];

/** A project's folder name under the brain's projects. */
const PROJECT_NAME = /^[A-Za-z0-9_][\w.-]*$/;

async function importProject(core: OpenOrc, layout: BrainLayout, { name, bundle, origin }: Extract<BrainControlRequest, { op: "import-project" }>): Promise<{ projectId: string }> {
  if (!PROJECT_NAME.test(name)) throw new Error("A project's name must be letters, digits, ., - or _.");
  const projects = path.join(layout.data, "projects");
  const folder = path.join(projects, name);
  if (await stat(folder).catch(() => null)) throw new Error(`The brain already has a project named ${name}.`);
  const source = path.join(layout.inbox, bundle);
  await mkdir(projects, { recursive: true });
  try {
    await git(projects, ["clone", "--quiet", source, folder]);
    if (origin) await git(folder, ["remote", "set-url", "origin", origin]);
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
  await rm(source, { force: true });
  const reply = await core.handle({ type: "rpc", id: 0, method: "projects.import", params: { rootPath: folder } });
  if (reply.type === "rpc.error") throw new Error(reply.message);
  return { projectId: (reply.result as Project).id };
}

/** Each control request onto services the core already has. Handed-over values are never logged or repeated. */
export function controlHandlers({ core, key, layout, stop }: ControlContext): (request: Extract<BrainControlRequest, { op: CoreOp }>) => Promise<unknown> {
  const handlers: Handlers = {
    pair: async () => {
      const { url, expiresAt } = await core.remote.beginPairing();
      return { url, expiresAt };
    },
    handover: async (request) => {
      const values = openHandover(key, request);
      const kinds = HANDOVER_KINDS.filter((kind) => values[kind] !== undefined);
      const refused = kinds.find((kind) => !HANDOVER[kind]);
      if (refused) throw new Error(`The brain does not take a ${refused} sign-in yet. Nothing was applied.`);
      for (const kind of kinds) await (HANDOVER[kind] as (core: OpenOrc, value: unknown) => Promise<unknown>)(core, values[kind]);
      return { applied: kinds };
    },
    "import-project": (request) => importProject(core, layout, request),
    stop: async () => {
      setImmediate(stop);
      return { stopping: true };
    },
  };
  return async (request) => {
    try {
      return await (handlers[request.op] as (request: BrainControlRequest) => Promise<unknown>)(request);
    } catch (error) {
      throw new Error(redact(error instanceof Error ? error.message : String(error)).text);
    }
  };
}
