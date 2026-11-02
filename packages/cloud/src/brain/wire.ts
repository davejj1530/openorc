/**
 * What crosses between the brain and whoever starts or asks it, one JSON object per line: the start line `serve` reads
 * on stdin, and the control requests `ctl` reads on stdin with the reply on its last stdout line. Each side parses what
 * it reads; a parse error names the field and never repeats a value, since lines carry keys and tokens.
 */
import { randomBytes } from "node:crypto";
import type { VercelConnection } from "../vercel-sandbox.js";
import { openSecret, sealSecret } from "./sealed-file.js";

declare const brainKeyBrand: unique symbol;
/** 32 random bytes that seal the brain's secrets. Held by whoever starts the brain and by its memory; never on its disk. */
export type BrainKey = Uint8Array & { readonly [brainKeyBrand]: true };
const KEY_BYTES = 32;

export function newBrainKey(): BrainKey {
  return new Uint8Array(randomBytes(KEY_BYTES)) as BrainKey;
}

function decodeKey(text: string): BrainKey | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  // The last character carries two unused bits, so only the text with them zero is the key's.
  return bytes.length === KEY_BYTES && bytes.toString("base64url") === text ? (new Uint8Array(bytes) as BrainKey) : null;
}

/** The key from its base64url text, as the starter keeps it. */
export function brainKeyFrom(text: string): BrainKey {
  const key = decodeKey(text);
  if (!key) throw new BrainWireError("A brain key", "key", "it must be 32 bytes in base64url");
  return key;
}

export function brainKeyText(key: BrainKey): string {
  return Buffer.from(key).toString("base64url");
}

/** A line from the other side that does not parse. */
export class BrainWireError extends Error {
  constructor(
    where: string,
    readonly field: string,
    problem = `${field} is missing or wrong`,
  ) {
    super(`${where} is not valid: ${problem}.`);
  }
}

type Parse<T> = (value: unknown, field: string) => T;
type Shape = Record<string, Parse<unknown>>;
type Parsed<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> };

class BadField extends Error {
  constructor(
    readonly field: string,
    readonly problem?: string,
  ) {
    super(field);
  }
}

const bad = (field: string, problem?: string): never => {
  throw new BadField(field, problem);
};
const join = (field: string, key: string) => (field ? `${field}.${key}` : key);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const text =
  (max: number, pattern?: RegExp): Parse<string> =>
  (value, field) =>
    typeof value === "string" && value.length > 0 && value.length <= max && (!pattern || pattern.test(value)) ? value : bad(field);
const int =
  (min: number, max: number): Parse<number> =>
  (value, field) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : bad(field);
const literal =
  <const T extends string | number | boolean>(...values: T[]): Parse<T> =>
  (value, field) => {
    const found = values.find((candidate) => candidate === value);
    return found === undefined ? bad(field) : found;
  };
const list =
  <T>(item: Parse<T>, max: number): Parse<T[]> =>
  (value, field) =>
    Array.isArray(value) && value.length <= max ? value.map((entry, index) => item(entry, `${field}[${index}]`)) : bad(field);
const nullable =
  <T>(parse: Parse<T>): Parse<T | null> =>
  (value, field) =>
    value === null ? null : parse(value, field);
const brainKey: Parse<BrainKey> = (value, field) => (typeof value === "string" ? decodeKey(value) : null) ?? bad(field);

/** Exactly these keys: every required one, any optional one, nothing else. An unknown key is never named. */
function object<R extends Shape, O extends Shape = Record<never, never>>(required: R, optional?: O): Parse<Parsed<R> & Partial<Parsed<O>>> {
  const allowed: Shape = { ...optional, ...required };
  return (value, field) => {
    if (!isRecord(value)) return bad(field, field ? undefined : "it is not an object");
    if (Object.keys(value).some((key) => !Object.hasOwn(allowed, key))) bad(field, `${field || "it"} has an unknown field`);
    const parsed: Record<string, unknown> = {};
    for (const [key, parse] of Object.entries(required)) parsed[key] = parse(value[key], join(field, key));
    for (const [key, parse] of Object.entries(optional ?? {})) if (value[key] !== undefined) parsed[key] = parse(value[key], join(field, key));
    return parsed as Parsed<R> & Partial<Parsed<O>>;
  };
}

function variants<T extends { op: string }>(table: { [K in T["op"]]: Parse<Extract<T, { op: K }>> }): Parse<T> {
  return (value, field) => {
    const op = isRecord(value) ? value["op"] : undefined;
    if (typeof op !== "string" || !Object.hasOwn(table, op)) return bad(join(field, "op"));
    return table[op as T["op"]](value, field);
  };
}

function parseLine<T>(where: string, parse: Parse<T>, line: string): T {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    // JSON.parse's message quotes the line, which can hold a key or a token.
    throw new BrainWireError(where, "line", "it is not JSON");
  }
  try {
    return parse(value, "");
  } catch (error) {
    if (error instanceof BadField) throw new BrainWireError(where, error.field, error.problem);
    throw error;
  }
}

/** What the waker hands the brain on the serve command's stdin, once per start. Never in argv, env or on disk. */
export interface BrainStart {
  key: BrainKey;
  /** What phones show for this host. */
  name: string;
  /** The public host name the proxy answers for this brain. */
  address: string;
  /** The port the sandbox declared, which the listener binds. */
  port: number;
  /** The brain's own sandbox and the connection its thread sandboxes are made with. Null in a local container: nothing keeps it awake, and no thread sandboxes. */
  vercel: { connection: VercelConnection; sandbox: string } | null;
}

const START = object({
  v: literal(1),
  key: brainKey,
  name: text(255),
  address: text(253, /^[A-Za-z0-9.-]+$/),
  port: int(1, 65_535),
  vercel: nullable(object({ connection: object({ token: text(4096), teamId: text(255), projectId: text(255) }, { vcpus: int(1, 64) }), sandbox: text(255) })),
});

export function encodeLaunch(start: BrainStart): string {
  return JSON.stringify({ v: 1, key: brainKeyText(start.key), name: start.name, address: start.address, port: start.port, vercel: start.vercel });
}

export function parseLaunch(line: string): BrainStart {
  const { key, name, address, port, vercel } = parseLine("The brain's start line", START, line);
  return { key, name, address, port, vercel };
}

/** A Claude account as the Mac has it, with the cloud token it signs in with. */
export interface HandoverClaudeAccount {
  id: string;
  name: string;
  /** The Mac's default account. */
  default: boolean;
  token: string;
}

/** Sign-ins the brain cannot make itself, by kind. They cross the wire only sealed under the brain key. */
export interface HandoverValues {
  /** Every Claude account that has a cloud token on the Mac, so an account missing here loses its sign-in on the brain. */
  claude: { accounts: HandoverClaudeAccount[] };
  codex: { auth: string };
  push: { keyId: string; pem: string };
}
export type HandoverKind = keyof HandoverValues;
export type BrainHandover = Partial<HandoverValues>;

const claudeAccounts: Parse<HandoverValues["claude"]> = (value, field) => {
  const account = object({ id: text(100), name: text(80), default: literal(true, false), token: text(4096) });
  const parsed = object({ accounts: list(account, 64) })(value, field);
  const ids = new Set(parsed.accounts.map((entry) => entry.id));
  if (ids.size !== parsed.accounts.length) bad(join(field, "accounts"), "two accounts share an id");
  if (parsed.accounts.filter((entry) => entry.default).length > 1) bad(join(field, "accounts"), "more than one account is the default");
  return parsed;
};

const HANDOVER: { [K in HandoverKind]: Parse<HandoverValues[K]> } = {
  claude: claudeAccounts,
  codex: object({ auth: text(65_536) }),
  push: object({ keyId: text(64), pem: text(8192) }),
};

export type BrainControlRequest =
  | { op: "status" }
  /** Status, asked by a waker that found the brain running: it counts as use, so the brain stays up for the caller. */
  | { op: "wake" }
  | { op: "pair" }
  /** Each value is base64url of `sealSecret` under the channel `handover/<kind>`. */
  | { op: "handover"; sealed: { [K in HandoverKind]?: string } }
  /** A git bundle already in the brain's inbox, by file name, cloned into its projects and imported. */
  | { op: "import-project"; name: string; bundle: string; origin?: string }
  /** Close gracefully and exit; the sandbox keeps running. */
  | { op: "stop" }
  /** A stop for an update, answered at once: refused, the brain running on, while closing would cut work short. */
  | { op: "stop-for-update" };
export type BrainControlOp = BrainControlRequest["op"];
export type HandoverRequest = Extract<BrainControlRequest, { op: "handover" }>;

export interface BrainStatus {
  state: "starting" | "ready" | "closing";
  /** The installed version it runs: its folder under the layout's apps. */
  version: string;
  pid: number;
  /** When this process started, in ms since the epoch. */
  since: number;
  /** Why closing it now would cut something short; null when it would not. */
  busy: string | null;
}

export interface BrainControlResults {
  status: BrainStatus;
  wake: BrainStatus;
  pair: { url: string; expiresAt: number };
  handover: { applied: HandoverKind[] };
  "import-project": { projectId: string };
  stop: { stopping: true };
  "stop-for-update": { stopping: true };
}
export type BrainControlResult<R extends BrainControlRequest> = BrainControlResults[R["op"]];
export type BrainControlReply<Op extends BrainControlOp> = { ok: true; result: BrainControlResults[Op] } | { ok: false; error: string };

const sealedText = text(131_072, /^[A-Za-z0-9_-]+$/);
const REQUESTS = variants<BrainControlRequest>({
  status: object({ op: literal("status") }),
  wake: object({ op: literal("wake") }),
  pair: object({ op: literal("pair") }),
  handover: object({ op: literal("handover"), sealed: object({}, { claude: sealedText, codex: sealedText, push: sealedText } satisfies Record<HandoverKind, Parse<string>>) }),
  "import-project": object({ op: literal("import-project"), name: text(100), bundle: text(255, /^\w[\w.-]*$/) }, { origin: text(2048) }),
  stop: object({ op: literal("stop") }),
  "stop-for-update": object({ op: literal("stop-for-update") }),
});

const timestamp = int(0, Number.MAX_SAFE_INTEGER);
const status = object({ state: literal("starting", "ready", "closing"), version: text(64), pid: int(1, 2 ** 31), since: timestamp, busy: nullable(text(100)) });
const RESULTS: { [K in BrainControlOp]: Parse<BrainControlResults[K]> } = {
  status,
  wake: status,
  pair: object({ url: text(4096), expiresAt: timestamp }),
  handover: object({ applied: list(literal("claude", "codex", "push"), 3) }),
  "import-project": object({ projectId: text(100) }),
  stop: object({ stopping: literal(true) }),
  "stop-for-update": object({ stopping: literal(true) }),
};

export function parseControlRequest(line: string): BrainControlRequest {
  return parseLine("The brain's control request", REQUESTS, line);
}

export function encodeControlReply<Op extends BrainControlOp>(reply: BrainControlReply<Op>): string {
  return JSON.stringify(reply);
}

export function parseControlReply<Op extends BrainControlOp>(op: Op, line: string): BrainControlReply<Op> {
  const answered = object({ ok: literal(true), result: RESULTS[op] });
  const refused = object({ ok: literal(false), error: text(2000) });
  return parseLine("The brain's control reply", (value, field) => (isRecord(value) && value["ok"] === false ? refused : answered)(value, field), line);
}

const handoverChannel = (kind: HandoverKind) => `handover/${kind}`;

export function sealHandover(key: BrainKey, handover: BrainHandover): HandoverRequest {
  const seal = <K extends HandoverKind>(kind: K): string | undefined => {
    const value = handover[kind];
    return value === undefined ? undefined : sealSecret(key, handoverChannel(kind), Buffer.from(JSON.stringify(value), "utf8")).toString("base64url");
  };
  const sealed: { [K in HandoverKind]-?: string | undefined } = { claude: seal("claude"), codex: seal("codex"), push: seal("push") };
  return { op: "handover", sealed };
}

/** The brain's side of a handover. Throws SealedUnreadable when it was sealed under another key. */
export function openHandover(key: BrainKey, request: HandoverRequest): BrainHandover {
  const open = <K extends HandoverKind>(kind: K): HandoverValues[K] | undefined => {
    const sealed = request.sealed[kind];
    if (sealed === undefined) return undefined;
    const plain = openSecret(key, handoverChannel(kind), Buffer.from(sealed, "base64url")).toString("utf8");
    return parseLine(`The handed-over ${kind}`, HANDOVER[kind], plain);
  };
  const handover: { [K in HandoverKind]: HandoverValues[K] | undefined } = { claude: open("claude"), codex: open("codex"), push: open("push") };
  return handover;
}
