/**
 * A person's own skills, as the server keeps them for their cloud turns: each skill's pack by its digest, and the set
 * each agent's turns get. It answers in the server's own sentences. While the `skills` capability is not on, every
 * route here answers 409 with the capability's reason, as the server does behind its switch.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StandInSpaces } from "./stand-in-spaces.js";

type Reply = { status: number; body: unknown };
type Pack = { name: string; bytes: Buffer; files: number };
type SetSkill = { name: string; digest: string };

const OFF = "Your skills aren't available in cloud threads yet.";
const AGENTS = ["claude", "codex", "opencode"];
const DIGEST = /^[0-9a-f]{64}$/;
const refusal = (status: number, message: string, code?: string): Reply => ({ status, body: { statusCode: status, message, ...(code && { code }) } });
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** A set's digest as the server names it: of each skill's name and digest, in the order of their names. */
export const setDigestOf = (skills: readonly SetSkill[]) =>
  sha256(
    skills
      .map((skill) => `${skill.name}:${skill.digest}`)
      .sort()
      .join("\n"),
  );

const CUT_SHORT = "That skill didn't arrive whole. Send it again.";

/** One file's header at `at`: its path, mode and length, and where its bytes start. Null when the pack ends inside it. */
function headerAt(pack: Buffer, at: number): { file: string; mode: string; length: string; bytesAt: number } | null {
  const fields: string[] = [];
  let next = at;
  for (let field = 0; field < 3; field++) {
    const end = pack.indexOf(0, next);
    if (end === -1) return null;
    fields.push(pack.subarray(next, end).toString("utf8"));
    next = end + 1;
  }
  return { file: fields[0]!, mode: fields[1]!, length: fields[2]!, bytesAt: next };
}

/** Why one file's header is not a skill's, in the server's sentence; null when it is. `name` is the pack's skill so far. */
function headerRefusal({ file, mode, length }: { file: string; mode: string; length: string }, name: string | null, paths: ReadonlySet<string>): string | null {
  const parts = file.split("/");
  if (parts.length < 2 || parts.some((part) => part === "" || part === "." || part === "..") || file.includes("\\")) return `A skill can't hold a file at ${JSON.stringify(file)}.`;
  if (parts[0]!.startsWith(".")) return `${JSON.stringify(parts[0])} can't be a skill's name.`;
  if (name !== null && parts[0] !== name) return "A pack holds one skill.";
  if (paths.has(file)) return `That skill names ${file} twice.`;
  return (mode !== "x" && mode !== "-") || !/^\d{1,12}$/.test(length) ? "That isn't a skill's pack." : null;
}

/** What a pack holds, or the server's sentence for why it is not a skill. */
function readPack(pack: Buffer): { name: string; files: number } | string {
  let at = 0;
  let name: string | null = null;
  const paths = new Set<string>();
  while (at < pack.length) {
    const header = headerAt(pack, at);
    if (!header) return CUT_SHORT;
    const refused = headerRefusal(header, name, paths);
    if (refused) return refused;
    name = header.file.split("/")[0]!;
    paths.add(header.file);
    at = header.bytesAt + Number(header.length);
    if (at > pack.length) return CUT_SHORT;
  }
  if (name === null) return "That skill has no files.";
  return paths.has(`${name}/SKILL.md`) ? { name, files: paths.size } : `${name} has no SKILL.md, so it isn't a skill.`;
}

export class StandInSkills {
  readonly #packs = new Map<string, Map<string, Pack>>();
  readonly #sets = new Map<string, { digest: string; skills: SetSkill[] }>();
  /** Every pack the server was sent, in order, kept or refused. */
  readonly sent: { who: string; digest: string }[] = [];
  /** Every set the server was sent, in order, kept or answered with what it lacks. */
  readonly asked: { who: string; agent: string; names: string[] }[] = [];

  constructor(private readonly deps: { spaces: StandInSpaces; available(): boolean }) {}

  /** The skills `who`'s turns with `agent` get, by name; null before their first set. */
  set(who: string, agent: string): string[] | null {
    return this.#sets.get(`${who} ${agent}`)?.skills.map((skill) => skill.name) ?? null;
  }

  /** The bytes of the pack `who` sent under `digest`. */
  pack(who: string, digest: string): Buffer | null {
    return this.#packs.get(who)?.get(digest)?.bytes ?? null;
  }

  /** Answers the skill routes, whose packs no JSON parser may read. False for any other request. */
  async answer(request: IncomingMessage, response: ServerResponse, holder: (token: string) => string | null): Promise<boolean> {
    const path = new URL(request.url ?? "/", "http://stand-in").pathname;
    const [, kind, named] = /^\/hosted\/(skills|skill-packs)\/([^/]+)$/.exec(path) ?? [];
    if (!kind || !named) return false;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    const who = holder(/^bearer (.+)$/i.exec(request.headers.authorization ?? "")?.[1]?.trim() ?? "");
    const header = request.headers["x-openorc-space"];
    const space = typeof header === "string" ? header : null;
    const reply = who ? this.#route(kind, { method: request.method ?? "GET", named, space }, who, Buffer.concat(chunks)) : refusal(401, "Unauthorized");
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(JSON.stringify(reply.body));
    return true;
  }

  #route(kind: string, asked: { method: string; named: string; space: string | null }, who: string, body: Buffer): Reply {
    const refused = this.#gate(who, asked.space);
    if (refused) return refused;
    if (kind === "skill-packs" && asked.method === "PUT") return this.#keep(who, asked.named, body);
    if (kind === "skills" && asked.method === "GET") return this.#read(who, asked.named);
    if (kind === "skills" && asked.method === "PUT") return this.#put(who, asked.named, body.length ? (JSON.parse(body.toString("utf8")) as Record<string, unknown>) : {});
    return refusal(404, `Cannot ${asked.method} /hosted/${kind}/${asked.named}`);
  }

  #gate(who: string, named: string | null): Reply | null {
    const space = this.deps.spaces.resolve(who, named);
    if (typeof space !== "string") return space;
    return this.deps.available() ? null : refusal(409, OFF, "feature_unavailable");
  }

  #keep(who: string, digest: string, bytes: Buffer): Reply {
    if (!DIGEST.test(digest)) return refusal(400, "Name a skill by the SHA-256 of its pack.");
    this.sent.push({ who, digest });
    const held = this.#packs.get(who)?.get(digest);
    if (held) return { status: 200, body: { digest, name: held.name, bytes: held.bytes.length, files: held.files } };
    const read = readPack(bytes);
    if (typeof read === "string") return refusal(400, read);
    if (sha256(bytes) !== digest) return refusal(400, CUT_SHORT);
    const mine = this.#packs.get(who) ?? new Map<string, Pack>();
    this.#packs.set(who, mine.set(digest, { ...read, bytes }));
    return { status: 200, body: { digest, name: read.name, bytes: bytes.length, files: read.files } };
  }

  #withBytes(who: string, skills: readonly SetSkill[]) {
    const packs = this.#packs.get(who);
    return skills.map((skill) => ({ ...skill, bytes: packs?.get(skill.digest)?.bytes.length ?? 0 }));
  }

  #read(who: string, agent: string): Reply {
    if (!AGENTS.includes(agent)) return refusal(400, "Name the agent whose skills these are.");
    const set = this.#sets.get(`${who} ${agent}`);
    return { status: 200, body: set ? { digest: set.digest, skills: this.#withBytes(who, set.skills) } : { digest: null, skills: [] } };
  }

  #put(who: string, agent: string, body: Record<string, unknown>): Reply {
    if (!AGENTS.includes(agent)) return refusal(400, "Name the agent whose skills these are.");
    if (!Array.isArray(body["skills"])) return refusal(400, "skills: Invalid input");
    const named = body["skills"] as SetSkill[];
    if (named.some((skill) => typeof skill?.name !== "string" || !DIGEST.test(String(skill?.digest)))) return refusal(400, "skills: Invalid input");
    if (new Set(named.map((skill) => skill.name)).size !== named.length) return refusal(400, "skills: Name each skill once.");
    this.asked.push({ who, agent, names: named.map((skill) => skill.name) });
    const packs = this.#packs.get(who) ?? new Map<string, Pack>();
    const missing = [...new Set(named.map((skill) => skill.digest))].filter((digest) => !packs.has(digest));
    if (missing.length) return { status: 200, body: { state: "missing", digests: missing } };
    const misnamed = named.find((skill) => packs.get(skill.digest)!.name !== skill.name);
    if (misnamed) return refusal(400, `${misnamed.name} isn't the skill that pack holds.`);
    const skills = [...named].sort((a, b) => (a.name < b.name ? -1 : 1));
    const digest = setDigestOf(skills);
    this.#sets.set(`${who} ${agent}`, { digest, skills });
    return { status: 200, body: { state: "kept", digest, skills: this.#withBytes(who, skills) } };
  }
}
