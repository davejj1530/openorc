import { z } from "zod";
import type { PushRefusal, RemotePushStatus } from "./push.js";
import type { CorePush, RpcMethod } from "./rpc.js";

/**
 * What a paired phone may call. Default deny: a method added to rpcParams is out of a phone's reach until it is
 * listed here, and the core keeps one guard per listed method in a table typed over this list.
 */
export const REMOTE_METHODS = [
  "projects.list",
  "projects.get",
  "projects.git",
  "threads.list",
  "threads.get",
  "threads.messages",
  "threads.lastMessage",
  "runs.listForThread",
  "events.page",
  "events.toolOutput",
  "inbox.list",
  "agents.models",
  "agents.availability",
  "providers.limits",
  "app.settings.get",
  "threads.start",
  "threads.update",
  "runs.start",
  "runs.send",
  "runs.interrupt",
  "threads.queue",
  "threads.unqueue",
  "threads.sendQueued",
  "approvals.resolve",
  "attachments.save",
  // A thread's changes, its commits and what Push would send, then commit, push and a pull request through the
  // desktop's own methods. Never the whole patch (`review.threadDiff`) or the Mac's paths (`system.info`).
  "review.threadChanges",
  "review.threadFileDiff",
  "git.threadLog",
  "git.threadPushState",
  "review.threadPrTemplate",
  "pulls.branches",
  "system.gh",
  "review.commitThread",
  "review.pushThread",
  "review.createThreadPr",
] as const satisfies readonly RpcMethod[];
export type RemoteMethod = (typeof REMOTE_METHODS)[number];

const remoteMethods: ReadonlySet<string> = new Set(REMOTE_METHODS);
export const isRemoteMethod = (method: string): method is RemoteMethod => remoteMethods.has(method);

/** The largest image a phone may attach, before base64. */
export const REMOTE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** How a phone reaches the Mac: the same network (a `.local` name or a private address), or Tailscale. */
export interface Route {
  kind: "lan" | "tailnet";
  host: string;
  port: number;
}

/**
 * Bytes a phone may fetch, always by a reference its transcript already holds, never by a path on the Mac. An
 * attachment by its stored file name, a tool image by the URL the ledger stored, an image an agent generated or
 * viewed by the activity that recorded it.
 */
export type AssetRef = { kind: "attachment"; name: string } | { kind: "tool-image"; url: string } | { kind: "activity"; runId: string; activityId: string };

/** The pushes a phone hears. `ready` carries nothing about the Mac's processes or ports. */
export type RemotePush = Extract<CorePush, { type: "frame" | "invalidate" | "notify" }> | { type: "ready" };

export interface RemoteDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  connected: boolean;
}

export type RemoteListener = { state: "off" } | { state: "on"; port: number; routes: Route[] } | { state: "failed"; reason: string };

export interface RemoteStatus {
  listener: RemoteListener;
  devices: RemoteDevice[];
  /** The open pairing offer, if any; its secret stays on the Mac and in the QR code. */
  pairing: { offerId: string; expiresAt: number } | null;
  push: RemotePushStatus;
}

export interface PairingOfferView {
  offerId: string;
  /** `openorc://pair#v1.<base64url>`, drawn as a QR code. Holds a one-time secret. */
  url: string;
  expiresAt: number;
}

/** Desktop-only: none of these is in REMOTE_METHODS, so a phone cannot pair others, list devices or turn access off. */
export const remoteRpcParams = {
  "remote.status": z.object({}).strict(),
  "remote.configure": z.object({ enabled: z.boolean() }).strict(),
  /** Replaces any open offer. */
  "remote.pairing.begin": z.object({}).strict(),
  "remote.pairing.cancel": z.object({ offerId: z.string().min(1).max(64) }).strict(),
  "remote.devices.remove": z.object({ id: z.string().min(1).max(64) }).strict(),
  /** The `.p8` Apple gave the user, its key id read from the file name. The PEM never comes back out. */
  "remote.push.setKey": z
    .object({
      keyId: z.string().regex(/^[A-Z0-9]{10}$/),
      pem: z.string().min(1).max(4096),
    })
    .strict(),
  "remote.push.removeKey": z.object({}).strict(),
  /** A test notice to every phone with notifications on. */
  "remote.push.test": z.object({}).strict(),
};

export interface RemoteRpcResults {
  "remote.status": RemoteStatus;
  "remote.configure": RemoteStatus;
  "remote.pairing.begin": PairingOfferView;
  "remote.pairing.cancel": null;
  "remote.devices.remove": null;
  "remote.push.setKey": RemoteStatus;
  "remote.push.removeKey": RemoteStatus;
  /** How many phones APNs took it for, how many it could not be handed over for (a network failure or an Apple outage), and Apple's refusal of the key if it refused. */
  "remote.push.test": { sent: number; failed: number; problem: PushRefusal | null };
}
