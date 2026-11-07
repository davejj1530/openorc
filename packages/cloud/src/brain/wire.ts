/**
 * What crosses between the brain and whoever starts or asks it, one JSON object per line: the start line `serve` reads
 * on stdin, and the control requests `ctl` reads on stdin with the reply on its last stdout line. Each side parses what
 * it reads; a parse error names the field and never repeats a value, since lines carry keys and tokens.
 */
import { createHash, randomBytes } from "node:crypto";
import type { CloudService, HarnessId } from "@openorc/protocol";
import type { Agent37Connection } from "../agent37-sandbox.js";
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
const textOrEmpty =
  (max: number): Parse<string> =>
  (value, field) =>
    typeof value === "string" && value.length <= max ? value : bad(field);
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
  /**
   * A brain on Agent37: its own instance and the connection its thread instances are made with. Absent elsewhere, and
   * from lines older brains read. Never in argv either, but kept in the instance's env as well: an instance that boots
   * again ends every process, and only that line starts the brain there without a waker. The same trust as the Vercel
   * door's env, which holds the key and token too.
   */
  agent37?: { connection: Agent37Connection; instance: string };
}

const START = object(
  {
    v: literal(1),
    key: brainKey,
    name: text(255),
    address: text(253, /^[A-Za-z0-9.-]+$/),
    port: int(1, 65_535),
    vercel: nullable(object({ connection: object({ token: text(4096), teamId: text(255), projectId: text(255) }, { vcpus: int(1, 64) }), sandbox: text(255) })),
  },
  {
    agent37: object({ connection: object({ key: text(4096), cpu: literal(2, 4), memory: literal(4, 8, 16, 32) }), instance: text(64, /^[a-z0-9]+$/) }),
  },
);

/** A Vercel brain's line has no `agent37`, so a brain from before it reads the line still. */
export function encodeLaunch(start: BrainStart): string {
  const { key, name, address, port, vercel, agent37 } = start;
  return JSON.stringify({ v: 1, key: brainKeyText(key), name, address, port, vercel, ...(agent37 ? { agent37 } : {}) });
}

export function parseLaunch(line: string): BrainStart {
  const { key, name, address, port, vercel, agent37 } = parseLine("The brain's start line", START, line);
  return { key, name, address, port, vercel, ...(agent37 ? { agent37 } : {}) };
}

/**
 * Everything the brain's door holds, as one sensitive env var of its project, written only by the Mac that set the
 * brain up. The door wakes the brain exactly as that Mac does, with its key, token and start inputs.
 */
export interface DoorConfig {
  key: BrainKey;
  /** The brain's team and project, and the token its sessions get. */
  vercel: { token: string; teamId: string; project: string };
  /** What phones show for the brain. */
  name: string;
  threadVcpus?: number;
  /** Device ids whose knocks are refused, for a phone cut off before its ticket runs out. */
  revoked: string[];
  /** The Mac's name for this config with the code it went out with: what the door answers on GET. */
  mark: string;
}

const DOOR = object(
  {
    v: literal(1),
    key: brainKey,
    vercel: object({ token: text(4096), teamId: text(255), project: text(100) }),
    name: text(255),
    revoked: list(text(100), 1000),
    mark: text(64, /^[A-Za-z0-9_-]+$/),
  },
  { threadVcpus: int(1, 64) },
);

export function encodeDoorConfig(config: DoorConfig): string {
  const { key, vercel, name, threadVcpus, revoked, mark } = config;
  return JSON.stringify({ v: 1, key: brainKeyText(key), vercel, name, ...(threadVcpus ? { threadVcpus } : {}), revoked, mark });
}

/** Null when the door holds none, or one it cannot read; such a door wakes nothing. Never throws, so never repeats it. */
export function readDoorConfig(text: string | undefined): DoorConfig | null {
  if (!text) return null;
  try {
    const { key, vercel, name, threadVcpus, revoked, mark } = parseLine("The door's config", DOOR, text);
    return { key, vercel, name, ...(threadVcpus ? { threadVcpus } : {}), revoked, mark };
  } catch {
    return null;
  }
}

/** A Claude account as the Mac has it, with the cloud token it signs in with. */
export interface HandoverClaudeAccount {
  id: string;
  name: string;
  /** The Mac's default account. */
  default: boolean;
  token: string;
}

/** A Codex login made on the Mac for the brain alone, never a copy of the Mac's own: a ChatGPT refresh token works once. */
export interface HandoverCodexLogin {
  /** The Mac's name for this sign-in, so the same one handed over again leaves the login the brain refreshed since. */
  id: string;
  mode: "chatgpt" | "apiKey";
  /** Codex's auth.json. */
  auth: string;
  email: string | null;
  plan: string | null;
}

/** Sign-ins the brain cannot make itself, by kind. They cross the wire only sealed under the brain key. Null takes the brain's away. */
export interface HandoverValues {
  /** Every Claude account that has a cloud token on the Mac, so an account missing here loses its sign-in on the brain. */
  claude: { accounts: HandoverClaudeAccount[] };
  codex: HandoverCodexLogin | null;
  /**
   * The GitHub CLI's sign-in on the Mac for github.com, and the author its commits carry, for the brain's own git and gh;
   * never its thread sandboxes'.
   */
  github: { token: string; name: string | null; email: string | null } | null;
  /** The Mac's APNs key, which the brain sends its phone alerts with. */
  push: { keyId: string; pem: string } | null;
  /** The Anthropic API key the Mac's memory distils with, while it does; the brain's memory then distils with it too. */
  memory: { apiKey: string } | null;
  /** OpenCode's provider keys entered on the Mac for the cloud; the brain's cloud turns use the one their model needs. */
  opencode: { keys: { provider: string; key: string }[] } | null;
  /**
   * Where the brain's new threads run, as the Mac's Settings says ("Run on"), and the connection to each service, so a
   * thread keeps running where it started. Vercel's is in the brain's own project there: the brain finds it, or makes it
   * on a team it has none on. Each is null while the Mac has it unconnected.
   */
  cloud: { service: CloudService; agent37: Agent37Connection | null; vercel: Omit<VercelConnection, "projectId"> | null };
  /** Each project's cloud environment, by the Mac project's id: the brain's threads in its copy get these variables. */
  env: { projects: { source: string; vars: { name: string; value: string }[] }[] } | null;
}
export type HandoverKind = keyof HandoverValues;
export type BrainHandover = Partial<HandoverValues>;

/** Names a handed-over value without holding it, the same on both sides whatever its keys' order, so each can tell a change. */
export function signInPrint(value: Record<string, unknown>): string {
  const entries = Object.keys(value)
    .sort()
    .map((key) => [key, value[key]]);
  return createHash("sha256").update(JSON.stringify(entries)).digest("base64url");
}

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
  codex: nullable(object({ id: text(100, /^[A-Za-z0-9_-]+$/), mode: literal("chatgpt", "apiKey"), auth: text(65_536), email: nullable(text(320)), plan: nullable(text(100)) })),
  github: nullable(object({ token: text(4096), name: nullable(text(255)), email: nullable(text(320)) })),
  push: nullable(object({ keyId: text(64), pem: text(8192) })),
  memory: nullable(object({ apiKey: text(4096) })),
  opencode: nullable(object({ keys: list(object({ provider: text(64, /^[a-z0-9][a-z0-9._-]*$/), key: text(1000) }), 100) })),
  cloud: object({
    service: literal("vercel", "agent37"),
    agent37: nullable(object({ key: text(4096), cpu: literal(2, 4), memory: literal(4, 8, 16, 32) })),
    vercel: nullable(object({ token: text(4096), teamId: text(255) }, { vcpus: int(1, 64), region: text(32, /^[a-z0-9]+$/) })),
  }),
  env: nullable(object({ projects: list(object({ source: text(200), vars: list(object({ name: text(128, /^[A-Za-z_][A-Za-z0-9_]*$/), value: text(32_768) }), 100) }), 1000) })),
};
const HANDOVER_KINDS = Object.keys(HANDOVER) as HandoverKind[];

export type BrainControlRequest =
  | { op: "status" }
  /** Status, asked by a waker that found the brain running: it counts as use, so the brain stays up for the caller. */
  | { op: "wake" }
  | { op: "pair" }
  /** Each value is base64url of `sealSecret` under the channel `handover/<kind>`. */
  | { op: "handover"; sealed: { [K in HandoverKind]?: string } }
  /**
   * A Mac project's branch as a git bundle already in the brain's inbox, by file name. The first one is cloned into the
   * brain's projects under the Mac project's id and name, and imported; each later one fast-forwards the copy. Sending
   * one again changes nothing.
   */
  | { op: "import-project"; source: string; name: string; branch: string; bundle: string; origin?: string }
  /** Removes the copy of a Mac project, by the Mac project's id, unless the brain has threads in it. */
  | { op: "remove-project"; source: string }
  /** The Mac projects the brain has copies of. */
  | { op: "projects" }
  /** The Mac found these copies hold its branch as it is now: each that still holds that commit counts as synced now. */
  | { op: "copies-current"; copies: { source: string; macHead: string }[] }
  /** The settings the Mac project has, for the brain's copy of it: its setup script runs in each new thread's sandbox. */
  | { op: "project-settings"; source: string; settings: CopySettings }
  /** What the brain holds of each sign-in besides Claude's, so the Mac takes its word over its own record. */
  | { op: "sign-ins" }
  /**
   * The user's skills chosen for cloud sessions, every agent's, as a file already in the brain's inbox: the brain keeps
   * exactly these, for the sandboxes it makes, and `digest` names them.
   */
  | { op: "cloud-skills"; file: string; digest: string }
  /** The phones paired with the brain. */
  | { op: "phones" }
  /** Unpairs a phone, which can no longer connect; one already gone changes nothing. Answers the phones left. */
  | { op: "remove-phone"; id: string }
  /** Close gracefully and exit; the sandbox keeps running. */
  | { op: "stop" }
  /** A stop for an update, answered at once: refused, the brain running on, while closing would cut work short. */
  | { op: "stop-for-update" }
  /** The brain's link key, so its Mac can dial it and name it to its phones. */
  | { op: "identity" }
  /** A thread's relocation package already in the inbox, by file name. Taking it again changes nothing. */
  | { op: "receive-thread"; relocation: string; package: string }
  /** Calls off a receive that may or may not have landed; one that comes later is refused. */
  | { op: "drop-arrival"; relocation: string; threadId: string }
  /** Freezes the thread and writes its package to the outbox. Asked again, the same package. */
  | { op: "hand-off-thread"; relocation: string; threadId: string }
  /** Unfreezes a thread the Mac did not take; a hand-off asked later is refused. */
  | { op: "cancel-hand-off"; relocation: string; threadId: string }
  /** The Mac took the thread: the brain deletes its copy, its sandbox and the package. */
  | { op: "handed-off"; relocation: string }
  /** The Mac's agent CLI versions: the brain installs each that differs, so a conversation moved either way resumes. Null keeps the brain's. */
  | { op: "agent-versions"; versions: AgentVersions }
  /**
   * The brain moves to another service: until `until`, it starts no new conversation, so none is left behind when it
   * goes. Asked again before each look at its threads; null starts them again, as when the move is called off.
   */
  | { op: "leaving"; until: number | null };

/** Each agent CLI's version, as its `--version` reads; null when unknown or not installed. */
export type AgentVersions = { [A in HarnessId]: string | null };
export type BrainControlOp = BrainControlRequest["op"];

/** What a Mac project's settings say about the work in it, which its copy on the brain takes as its own. */
export interface CopySettings {
  setupScript: string | null;
  branchPrefix: string;
  worktreeInclude: string[];
}
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

/** A phone paired with the brain, as its Mac's Settings lists it. */
export interface BrainPhone {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  connected: boolean;
}

/** A Mac project's copy on the brain. */
export interface ProjectCopy {
  projectId: string;
  /** The Mac's commit it last took. */
  macHead: string;
  /** The copy's own commit on the branch: another than macHead once it kept commits the Mac's lacks. */
  head: string;
}

export interface BrainControlResults {
  status: BrainStatus;
  wake: BrainStatus;
  pair: { url: string; expiresAt: number };
  handover: { applied: HandoverKind[] };
  /** `lacksBase`: the copy lacks the commit the bundle builds on, so it took nothing; a whole bundle will do. */
  "import-project": ProjectCopy | { lacksBase: true };
  "remove-project": { removed: boolean; threads: number };
  projects: { copies: (ProjectCopy & { source: string; threads: number })[] };
  "copies-current": { marked: number };
  /** False when the brain has no copy of that project. */
  "project-settings": { applied: boolean };
  /**
   * The id of the Codex login it holds, the signInPrint of its GitHub sign-in, of its memory key, of its OpenCode keys and
   * of where its threads run, and its push key's id; null for none. A brain from before OpenCode keys, or before the
   * cloud kind, names none of those.
   */
  "sign-ins": {
    codex: string | null;
    github: string | null;
    push: string | null;
    memory: string | null;
    opencode?: string | null;
    cloud?: string | null;
    /** The signInPrint of the projects' cloud environments it holds; null for none. */
    env?: string | null;
    /** The digest of the skills it keeps for cloud sessions; null for none. */
    skills?: string | null;
  };
  "cloud-skills": { kept: number };
  phones: { phones: BrainPhone[] };
  "remove-phone": { phones: BrainPhone[] };
  stop: { stopping: true };
  "stop-for-update": { stopping: true };
  identity: { linkKey: string };
  /** `lacksBase`: the brain's copy lacks the commit the package's code builds on, so it took nothing; a whole one will do. */
  "receive-thread": { received: true } | { refused: string } | { lacksBase: true };
  "drop-arrival": { dropped: true } | { received: true };
  "hand-off-thread": { file: string; bytes: number; sha256: string } | { refused: string };
  "cancel-hand-off": { stayed: true } | { left: true };
  "handed-off": { left: true };
  /** What the brain has after: an install that failed leaves the version it had. */
  "agent-versions": { versions: AgentVersions };
  leaving: { until: number | null };
}
export type BrainControlResult<R extends BrainControlRequest> = BrainControlResults[R["op"]];
export type BrainControlReply<Op extends BrainControlOp> = { ok: true; result: BrainControlResults[Op] } | { ok: false; error: string };

const sealedText = text(131_072, /^[A-Za-z0-9_-]+$/);
const sealedEnv = text(524_288, /^[A-Za-z0-9_-]+$/);
const projectSource = text(100, /^[A-Za-z0-9_-]+$/);
/** One folder's name: no separator or control character, and not . or .. */
const folderName: Parse<string> = (value, field) => {
  const name = text(100)(value, field);
  const unsafe = name === "." || name === ".." || [...name].some((char) => char === "/" || char === "\\" || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  return unsafe ? bad(field) : name;
};
const branchName = text(255, /^\w[\w./+-]*$/);

/** Whether the brain takes a project by this folder name and branch, as its import does. */
export function brainTakesProject(name: string, branch: string): boolean {
  try {
    folderName(name, "name");
    branchName(branch, "branch");
    return true;
  } catch {
    return false;
  }
}
const commit = text(64, /^[0-9a-f]{40,64}$/);
const count = int(0, Number.MAX_SAFE_INTEGER);
const relocationId = text(64, /^[A-Za-z0-9-]+$/);
const threadId = text(100, /^[A-Za-z0-9-]+$/);
const deviceId = text(100, /^[A-Za-z0-9-]+$/);
const packageFile = text(255, /^\w[\w.-]*$/);
const refused = object({ refused: text(2000) });
const release = nullable(text(32, /^\d+\.\d+\.\d+$/));
const agentVersions = object({ claude: release, codex: release, opencode: release } satisfies { [A in HarnessId]: Parse<string | null> });
const REQUESTS = variants<BrainControlRequest>({
  status: object({ op: literal("status") }),
  wake: object({ op: literal("wake") }),
  pair: object({ op: literal("pair") }),
  handover: object({
    op: literal("handover"),
    // The projects' environments may run larger than a sign-in; the whole request still fits ctl's line.
    sealed: object({}, Object.fromEntries(HANDOVER_KINDS.map((kind) => [kind, kind === "env" ? sealedEnv : sealedText])) as Record<HandoverKind, Parse<string>>),
  }),
  "import-project": object({ op: literal("import-project"), source: projectSource, name: folderName, branch: branchName, bundle: text(255, /^\w[\w.-]*$/) }, { origin: text(2048) }),
  "cloud-skills": object({ op: literal("cloud-skills"), file: text(255, /^\w[\w.-]*$/), digest: text(64, /^[a-f0-9]{64}$/) }),
  "remove-project": object({ op: literal("remove-project"), source: projectSource }),
  projects: object({ op: literal("projects") }),
  "copies-current": object({ op: literal("copies-current"), copies: list(object({ source: projectSource, macHead: commit }), 10_000) }),
  "project-settings": object({
    op: literal("project-settings"),
    source: projectSource,
    settings: object({ setupScript: nullable(text(65_536)), branchPrefix: textOrEmpty(100), worktreeInclude: list(text(1000), 1000) }),
  }),
  "sign-ins": object({ op: literal("sign-ins") }),
  phones: object({ op: literal("phones") }),
  "remove-phone": object({ op: literal("remove-phone"), id: deviceId }),
  stop: object({ op: literal("stop") }),
  "stop-for-update": object({ op: literal("stop-for-update") }),
  identity: object({ op: literal("identity") }),
  "receive-thread": object({ op: literal("receive-thread"), relocation: relocationId, package: packageFile }),
  "drop-arrival": object({ op: literal("drop-arrival"), relocation: relocationId, threadId }),
  "hand-off-thread": object({ op: literal("hand-off-thread"), relocation: relocationId, threadId }),
  "cancel-hand-off": object({ op: literal("cancel-hand-off"), relocation: relocationId, threadId }),
  "handed-off": object({ op: literal("handed-off"), relocation: relocationId }),
  "agent-versions": object({ op: literal("agent-versions"), versions: agentVersions }),
  leaving: object({ op: literal("leaving"), until: nullable(int(0, Number.MAX_SAFE_INTEGER)) }),
});

const timestamp = int(0, Number.MAX_SAFE_INTEGER);
const projectCopy = object({ projectId: text(100), macHead: commit, head: commit });
const status = object({ state: literal("starting", "ready", "closing"), version: text(64), pid: int(1, 2 ** 31), since: timestamp, busy: nullable(text(100)) });
const phones = object({ phones: list(object({ id: deviceId, name: textOrEmpty(255), createdAt: timestamp, lastSeenAt: nullable(timestamp), connected: literal(true, false) }), 1000) });
const RESULTS: { [K in BrainControlOp]: Parse<BrainControlResults[K]> } = {
  status,
  wake: status,
  pair: object({ url: text(4096), expiresAt: timestamp }),
  handover: object({ applied: list(literal(...HANDOVER_KINDS), HANDOVER_KINDS.length) }),
  "import-project": (value, field) => (isRecord(value) && value["lacksBase"] === true ? object({ lacksBase: literal(true) }) : projectCopy)(value, field),
  "remove-project": object({ removed: literal(true, false), threads: count }),
  projects: object({ copies: list(object({ source: projectSource, projectId: text(100), macHead: commit, head: commit, threads: count }), 10_000) }),
  "copies-current": object({ marked: count }),
  "project-settings": object({ applied: literal(true, false) }),
  "sign-ins": object(
    { codex: nullable(text(100)), github: nullable(text(64)), push: nullable(text(64)), memory: nullable(text(64)) },
    { opencode: nullable(text(64)), cloud: nullable(text(64)), env: nullable(text(64)), skills: nullable(text(64)) },
  ),
  "cloud-skills": object({ kept: int(0, 10_000) }),
  phones,
  "remove-phone": phones,
  stop: object({ stopping: literal(true) }),
  "stop-for-update": object({ stopping: literal(true) }),
  identity: object({ linkKey: text(64, /^[A-Za-z0-9_-]+$/) }),
  "receive-thread": (value, field) => {
    if (isRecord(value) && "refused" in value) return refused(value, field);
    return (isRecord(value) && "lacksBase" in value ? object({ lacksBase: literal(true) }) : object({ received: literal(true) }))(value, field);
  },
  "drop-arrival": (value, field) => (isRecord(value) && "received" in value ? object({ received: literal(true) }) : object({ dropped: literal(true) }))(value, field),
  "hand-off-thread": (value, field) => (isRecord(value) && "refused" in value ? refused : object({ file: packageFile, bytes: count, sha256: text(64, /^[0-9a-f]{64}$/) }))(value, field),
  "cancel-hand-off": (value, field) => (isRecord(value) && "left" in value ? object({ left: literal(true) }) : object({ stayed: literal(true) }))(value, field),
  "handed-off": object({ left: literal(true) }),
  "agent-versions": object({ versions: agentVersions }),
  leaving: object({ until: nullable(timestamp) }),
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
  const sealed: { [K in HandoverKind]-?: string | undefined } = {
    claude: seal("claude"),
    codex: seal("codex"),
    github: seal("github"),
    push: seal("push"),
    memory: seal("memory"),
    opencode: seal("opencode"),
    cloud: seal("cloud"),
    env: seal("env"),
  };
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
  const handover: { [K in HandoverKind]: HandoverValues[K] | undefined } = {
    claude: open("claude"),
    codex: open("codex"),
    github: open("github"),
    push: open("push"),
    memory: open("memory"),
    opencode: open("opencode"),
    cloud: open("cloud"),
    env: open("env"),
  };
  return handover;
}
