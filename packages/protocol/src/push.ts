import { z } from "zod";
import type { CorePush } from "./rpc.js";

/** The iPhone app: its APNs topic and the team whose key signs for it. apps/mobile/app.json must agree (tested). */
export const PHONE_APP = { bundleId: "app.openorc.mobile", teamId: "8VR6L6XPS9" } as const;

export type NotifyKind = Extract<CorePush, { type: "notify" }>["kind"];

const pushRegistration = z
  .object({
    /** The APNs device token, lowercase hex, as expo-notifications gives it. */
    token: z.string().regex(/^[0-9a-f]{64,200}$/),
    environment: z.enum(["sandbox", "production"]),
    /** What a phone takes. "Off" is no registration at all. */
    alerts: z.enum(["all", "needs-you"]),
    sound: z.boolean(),
  })
  .strict();
export type PushRegistration = z.infer<typeof pushRegistration>;
export type PushEnvironment = PushRegistration["environment"];
export type PushAlerts = PushRegistration["alerts"];

/** Whether this Mac can send at all. */
export type PushSenderState = "ready" | "no-key" | "refused";
/**
 * What this Mac can do for a phone on each APNs host. Apple can refuse a key on one host and take it on the other, and
 * a phone that has not registered yet names none, so each phone reads the one its build's aps-environment gives it.
 */
export type PushSenderStates = Record<PushEnvironment, PushSenderState>;

/** Invalidated when the Mac's sender state changes, so a connected phone registers again and hears the new state. */
export const PUSH_SENDER_TAG = "push.sender";

/**
 * Methods about the calling phone itself. RemoteSession answers them with its own device id; no core handler sees
 * them, and they are not RpcMethods, so no phone can name another phone.
 */
export const deviceRpcParams = {
  /** Null stops alerts to this phone. */
  "push.register": z.object({ registration: pushRegistration.nullable() }).strict(),
  /** This phone's key to wake its host through the host's door, renewed on every session. */
  "door.key": z.object({}).strict(),
};
export type DeviceMethod = keyof typeof deviceRpcParams;
export type DeviceParams<M extends DeviceMethod> = z.infer<(typeof deviceRpcParams)[M]>;

/**
 * What a host that sleeps gives a phone to knock on its door with: its ticket for this phone's own device id, for one
 * epoch. The ticket is a secret, kept in the phone's Keychain only.
 */
export interface DoorKey {
  /** The door's host name. */
  host: string;
  /** This phone's id on the host, as its paired list names it. */
  device: string;
  epoch: number;
  /** 32 bytes, base64url. */
  ticket: string;
}

export interface DeviceRpcResults {
  "push.register": PushSenderStates;
  /** Null from a host without a door, such as a Mac. */
  "door.key": DoorKey | null;
}
export const isDeviceMethod = (method: string): method is DeviceMethod => Object.hasOwn(deviceRpcParams, method);

/** Which alerts each kind belongs to. A new kind does not compile until it is placed. */
export const pushGroups = {
  approval: "needs-you",
  question: "needs-you",
  finished: "all",
  error: "all",
  task: "all",
  schedule: "all",
} as const satisfies Record<NotifyKind, PushAlerts>;

/** Apple refusing the Mac's key on one host. A key can be good for one environment and not the other. */
export interface PushRefusal {
  reason: string;
  environment: PushEnvironment;
}

export interface RemotePushStatus {
  /** The key id this Mac signs with, or null before one is added. The key itself never leaves the core. */
  keyId: string | null;
  /** Paired phones holding a registration. */
  phones: number;
  /** Apple's refusal of the key, kept until a send to that environment succeeds or the key changes. The sandbox's comes first. */
  problem: PushRefusal | null;
}
