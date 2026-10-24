import type { AssetRef, RemotePush, Route } from "@openorc/protocol";

/** Bumped when either end would misread the other. The Mac refuses a phone that speaks another version. */
export const LINK_VERSION = 1;

/** Why the Mac declined a phone. Each is one screen on the phone; none is worth retrying in a loop. */
export type Refusal = "unpaired" | "offer-invalid" | "incompatible" | "busy";
/** Why the Mac is about to end a session on purpose. */
export type ClosingReason = "update" | "shutdown" | "removed" | "disabled";

/** The phone's handshake payload. `pair` spends a pairing offer, on the first connection only. */
export interface PhoneHello {
  t: "hello";
  version: number;
  device: { name: string };
  pair?: { offerId: string; secret: string };
}

/** The Mac's handshake payload. `routes` is how the Mac can be reached now, so a phone heals a stale address. */
export type MacHello = { t: "hello"; version: number; mac: { name: string }; deviceId: string; routes: Route[] } | { t: "refused"; reason: Refusal };

export type PhoneMessage =
  | { t: "rpc"; id: number; method: string; params?: unknown }
  /** The runs whose frames the phone wants. Replaces the previous set, so sending it again changes nothing. */
  | { t: "interest"; runIds: string[] }
  | { t: "asset"; id: number; ref: AssetRef }
  | { t: "ping"; id: number };

export type MacMessage =
  | { t: "rpc.result"; id: number; result: unknown }
  | { t: "rpc.error"; id: number; message: string }
  | { t: "push"; push: RemotePush }
  /** Frames for these runs were dropped while the phone fell behind; it reloads them from the ledger. */
  | { t: "gap"; runIds: string[] }
  /** The asset asked for under `id` follows as a byte stream with the same id. */
  | { t: "asset.bytes"; id: number; mime: string; size: number }
  | { t: "asset.error"; id: number; message: string }
  | { t: "pong"; id: number }
  | { t: "closing"; reason: ClosingReason };

export type LinkMessage = PhoneHello | MacHello | PhoneMessage | MacMessage;

export class LinkProtocolError extends Error {}

type Check = (value: unknown) => boolean;
type Fields = Record<string, Check>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text =
  (max: number): Check =>
  (value) =>
    typeof value === "string" && value.length > 0 && value.length <= max;
const anyText: Check = (value) => typeof value === "string";
const count: Check = (value) => Number.isSafeInteger(value) && (value as number) >= 0;
/** An asset's id doubles as the u32 stream id of its byte records. */
const streamId: Check = (value) => count(value) && (value as number) <= 0xffff_ffff;
const port: Check = (value) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
const present: Check = () => true;
const oneOf =
  (...values: string[]): Check =>
  (value) =>
    typeof value === "string" && values.includes(value);
const list =
  (item: Check, max: number): Check =>
  (value) =>
    Array.isArray(value) && value.length <= max && value.every(item);

/** Exactly these keys: every required one, any optional one, nothing else. */
function shape(required: Fields, optional: Fields = {}): Check {
  return (value) =>
    isRecord(value) &&
    Object.keys(value).every((key) => Object.hasOwn(required, key) || Object.hasOwn(optional, key)) &&
    Object.entries(required).every(([key, check]) => Object.hasOwn(value, key) && check(value[key])) &&
    Object.entries(optional).every(([key, check]) => !Object.hasOwn(value, key) || check(value[key]));
}

function variants(tag: string, table: Record<string, Check>): Check {
  return (value) => {
    if (!isRecord(value)) return false;
    const kind = value[tag];
    return typeof kind === "string" && Object.hasOwn(table, kind) && table[kind]!(value);
  };
}

const message = (fields: Fields, optional?: Fields) => shape({ t: present, ...fields }, optional);
const route = shape({ kind: oneOf("lan", "tailnet"), host: text(253), port });
const assetRef = variants("kind", {
  attachment: shape({ kind: present, name: text(255) }),
  "tool-image": shape({ kind: present, url: text(512) }),
  generated: shape({ kind: present, runId: text(100), activityId: text(200) }),
} satisfies Record<AssetRef["kind"], Check>);
const pushTypes: RemotePush["type"][] = ["frame", "invalidate", "notify", "ready"];
// The Mac is authenticated and pushes are the hot path, so the phone checks the envelope and trusts the body.
const push: Check = (value) => isRecord(value) && oneOf(...pushTypes)(value["type"]);

const phoneHello = variants("t", {
  hello: message({ version: count, device: shape({ name: text(80) }) }, { pair: shape({ offerId: text(64), secret: text(64) }) }),
} satisfies Record<PhoneHello["t"], Check>);
const macHello = variants("t", {
  hello: message({ version: count, mac: shape({ name: text(255) }), deviceId: text(64), routes: list(route, 32) }),
  refused: message({ reason: oneOf("unpaired", "offer-invalid", "incompatible", "busy") }),
} satisfies Record<MacHello["t"], Check>);

const phoneMessage = variants("t", {
  rpc: message({ id: count, method: text(100) }, { params: present }),
  interest: message({ runIds: list(text(100), 256) }),
  asset: message({ id: streamId, ref: assetRef }),
  ping: message({ id: count }),
} satisfies Record<PhoneMessage["t"], Check>);

const macMessage = variants("t", {
  "rpc.result": message({ id: count, result: present }),
  "rpc.error": message({ id: count, message: anyText }),
  push: message({ push }),
  gap: message({ runIds: list(text(100), 4096) }),
  "asset.bytes": message({ id: count, mime: text(100), size: count }),
  "asset.error": message({ id: count, message: anyText }),
  pong: message({ id: count }),
  closing: message({ reason: oneOf("update", "shutdown", "removed", "disabled") }),
} satisfies Record<MacMessage["t"], Check>);

function parser<T>(check: Check, what: string): (value: unknown) => T {
  return (value) => {
    if (!check(value)) throw new LinkProtocolError(`not a ${what}`);
    return value as T;
  };
}

export const parsePhoneHello = parser<PhoneHello>(phoneHello, "phone hello");
export const parseMacHello = parser<MacHello>(macHello, "Mac hello");
export const parsePhoneMessage = parser<PhoneMessage>(phoneMessage, "phone message");
export const parseMacMessage = parser<MacMessage>(macMessage, "Mac message");
