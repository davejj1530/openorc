import path from "node:path";
import { redactValue } from "@openorc/db";
import { isRemoteMethod, REMOTE_ATTACHMENT_BYTES, rpcParams, type RemoteMethod, type RemotePush, type RpcParams } from "@openorc/protocol";
import type { Broadcast } from "../transport.js";

/*
 * What a paired phone may do and hear. A paired phone is the user, able to start autonomous work on this Mac, so
 * pairing and the encrypted session are the boundary. This is least privilege on top: host paths, secrets, remote
 * access itself and desktop-only flows stay on the Mac.
 */

export interface GuardContext {
  /** The only folder a phone's attachment paths may name. */
  attachmentsDir: string;
}

/** Null admits; a string refuses with that message. Guards see params already parsed by the method's schema. */
type Guard<M extends RemoteMethod> = (params: RpcParams<M>, context: GuardContext) => string | null;

const allow = () => null;
const STORED_IMAGE = /^[a-f0-9-]+\.(?:png|jpg|gif|webp)$/;
const MAX_ATTACHMENT_BASE64 = Math.ceil(REMOTE_ATTACHMENT_BYTES / 3) * 4;
/** What the phone's own controls change: read state and the composer's settings. */
const PHONE_THREAD_PATCH = new Set(["seen", "agent", "model", "effort", "fastMode", "mode", "permissionMode"]);

/** Each path must be an image this profile stored with attachments.save. */
function storedImages(paths: readonly string[] | undefined, { attachmentsDir }: GuardContext): string | null {
  const foreign = paths?.some((file) => path.resolve(file) !== file || path.dirname(file) !== attachmentsDir || !STORED_IMAGE.test(path.basename(file)));
  return foreign ? "Only images attached from your phone can be sent from it." : null;
}

/** Typed over REMOTE_METHODS: a method listed there without a guard here, or guarded but not listed, fails the build. */
export const remoteGuards: { [M in RemoteMethod]: Guard<M> } = {
  "projects.list": allow,
  "projects.get": allow,
  "threads.list": allow,
  "threads.get": allow,
  "threads.messages": allow,
  "threads.lastMessage": allow,
  "runs.listForThread": allow,
  "events.page": allow,
  "events.toolOutput": allow,
  "inbox.list": allow,
  "agents.models": allow,
  "app.settings.get": allow,
  "threads.start": (params, context) => (params.workingDirectory !== undefined ? "Choose a folder for this conversation on your Mac." : storedImages(params.attachments, context)),
  "threads.update": (params) => (params.taskId === undefined && Object.keys(params.patch).every((key) => PHONE_THREAD_PATCH.has(key)) ? null : "Make this change on your Mac."),
  "runs.start": (params, context) => storedImages(params.attachments, context),
  "runs.send": (params, context) => storedImages(params.attachments, context),
  "runs.interrupt": allow,
  "threads.queue": (params, context) => storedImages(params.attachments, context),
  "threads.unqueue": allow,
  "threads.sendQueued": allow,
  "approvals.resolve": allow,
  "attachments.save": (params) => (params.dataBase64.length > MAX_ATTACHMENT_BASE64 ? `Images sent from a phone must be ${REMOTE_ATTACHMENT_BYTES / 1024 / 1024} MB or smaller.` : null),
};

export type RemoteAdmission = { ok: true } | { ok: false; message: string };

/** Admits one phone request or says why not. Params a method's schema rejects pass through, so `handle` words the error. */
export function admitRemoteRequest(method: string, params: unknown, context: GuardContext): RemoteAdmission {
  if (!isRemoteMethod(method)) return { ok: false, message: "This is not available from a phone." };
  const parsed = rpcParams[method].safeParse(params ?? {});
  if (!parsed.success) return { ok: true };
  const refusal = (remoteGuards[method] as Guard<RemoteMethod>)(parsed.data as RpcParams<RemoteMethod>, context);
  return refusal ? { ok: false, message: refusal } : { ok: true };
}

/** Every push the core makes, and what a phone hears of it. A new push type does not compile until it is placed. */
const pushes: { [T in Broadcast["type"]]: (push: Extract<Broadcast, { type: T }>) => RemotePush | null } = {
  frame: (push) => push,
  invalidate: (push) => push,
  // Titles quote commands an agent wants to run.
  notify: (push) => redactValue(push).value,
  // The core's process id and MCP port are the Mac's business.
  ready: () => ({ type: "ready" }),
  // A phone only ever meets a core that is up. Logs carry paths and provider output; benchmarks are QA traffic.
  startup: () => null,
  log: () => null,
  "bench.done": () => null,
};

export function remotePush(push: Broadcast): RemotePush | null {
  return (pushes[push.type] as (push: Broadcast) => RemotePush | null)(push);
}
