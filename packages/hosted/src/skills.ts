/**
 * The person's own skills, made the server's before a turn of theirs may start, so the agent in the cloud finds what
 * it finds on this device. The host says what the person has for an agent, each skill by its name and the digest of
 * its pack; the server keeps a pack once, so only one it lacks is ever sent, and a set it already keeps costs nothing.
 *
 * The packs the server lacks go up a few at once, and the set goes ahead of a start (`ahead`), so a first thread
 * usually has none to send. While packs go up, `sending` says how many of how many, for the start that waits on them.
 *
 * Nothing is sent to a server that does not serve skills: one with no capabilities at all is asked once a session,
 * one that says they are not available is asked again after a minute. A failure is the caller's to show: the message
 * it was sending stays where it is, and sending it again tries again.
 */
import { isHostedAgent, type AccountStatus, type HostedAgent } from "@openorc/protocol";
import { RawBody } from "./raw-body.js";
import { Refused, Unreadable, type Requests, type Session } from "./session.js";
import { PARITY_ROUTES } from "./wire-parity.js";
import { SKILL_ROUTES } from "./wire-skills.js";

/** One skill of the person's on this device. */
export interface OwnSkill {
  /** Its folder's name, which the agent in the cloud finds it under. */
  name: string;
  /** The lowercase hex SHA-256 of its pack. */
  digest: string;
  /**
   * Its pack, read as it is sent: each file as `<path>\0<mode>\0<length>\0<bytes>`, `<path>` starting with `name`,
   * `<mode>` `x` for a file that runs and `-` otherwise. Rejects in words when the skill can no longer be read.
   */
  pack(): AsyncIterable<Uint8Array>;
}

/** The person's own skills for `agent` on this device, as the host reads them. */
export type OwnSkills = (agent: HostedAgent) => Promise<readonly OwnSkill[]>;

/** How long "not available" stands before the server is asked again. */
const ASK_AGAIN_MS = 60_000;
/** How many packs go up at once. */
const PACKS_AT_ONCE = 6;

/** Packs of an agent's set going up now: how many have, of how many the server lacked. */
export type SkillsSending = { sent: number; total: number };

type Served = { state: "on" } | { state: "absent" } | { state: "off"; at: number };

/** A set's digest as the server names it: of each skill's name and digest, in the order of their names. */
async function setDigest(skills: readonly { name: string; digest: string }[]): Promise<string> {
  const lines = skills
    .map((skill) => `${skill.name}:${skill.digest}`)
    .sort()
    .join("\n");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lines));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class Skills {
  #generation = -1;
  #served: Served | null = null;
  /** The set the server keeps for each agent, as this session last heard it kept. */
  readonly #kept = new Map<string, string>();
  /** The send under way for each agent, so two messages at once send one set. */
  readonly #bringing = new Map<string, Promise<void>>();
  readonly #sending = new Map<HostedAgent, SkillsSending>();
  /** The session, space and agents the sets last went ahead for. */
  #ahead = "";
  #asking: Promise<boolean> | null = null;
  /** The packs going up now, by digest. */
  readonly #packing = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: { session: Session; own: OwnSkills | undefined; now(): number; changed?: () => void }) {}

  /** The packs of the agent's set going up now, or null when none are. */
  sending(agent: HostedAgent): SkillsSending | null {
    return this.#sending.get(agent) ?? null;
  }

  /**
   * Brings the set of each agent the person signed in to OpenOrc Cloud with ahead of any start, so a first thread finds
   * them kept: once for a session, their space and agents, and again whenever this device's skills `changed`. A failure
   * is left for the start, which tries again and says so.
   */
  async ahead(account: AccountStatus, catalog: () => Promise<{ personal: string | null; ids: readonly string[] }>, changed = false): Promise<void> {
    if (!this.deps.own || account.state !== "signed-in") return;
    const agents = [...new Set((account.signIns ?? []).filter((row) => !row.ended).map((row) => row.agent))].sort();
    const read = await catalog().catch(() => null);
    const space = read && (read.personal ?? read.ids[0]);
    if (!space || !agents.length) return;
    const key = JSON.stringify([this.deps.session.generation, space, agents]);
    if (key === this.#ahead && !changed) return;
    this.#ahead = key;
    await Promise.all(agents.map((agent) => this.bring(space, agent).catch(() => undefined)));
  }

  /**
   * Makes what the person has for `agent` on this device what their turns with it get, asked in `space`. Resolves with
   * nothing sent where the server serves no skills or the device has none to give.
   */
  bring(space: string, agent: string): Promise<void> {
    if (!this.deps.own || !isHostedAgent(agent)) return Promise.resolve();
    const before = this.#bringing.get(agent) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(() => this.#bring(this.deps.session.in(space), agent));
    this.#bringing.set(agent, next);
    const done = () => {
      if (this.#bringing.get(agent) === next) this.#bringing.delete(agent);
    };
    next.then(done, done);
    return next;
  }

  async #bring(on: Requests, agent: HostedAgent): Promise<void> {
    if (this.#generation !== this.deps.session.generation) {
      this.#generation = this.deps.session.generation;
      this.#served = null;
      this.#kept.clear();
    }
    if (!(await this.#serves(on))) return;
    const skills = await this.deps.own!(agent);
    const named = skills.map(({ name, digest }) => ({ name, digest }));
    const digest = await setDigest(named);
    if (this.#kept.get(agent) === digest) return;
    try {
      let answer = await on.request(SKILL_ROUTES.set(agent), { skills: named });
      if (answer.state === "missing") {
        const lacking = answer.digests.map((missing) => {
          const skill = skills.find((each) => each.digest === missing);
          if (!skill) throw new Unreadable();
          return skill;
        });
        await this.#send(on, agent, lacking);
        answer = await on.request(SKILL_ROUTES.set(agent), { skills: named });
      }
      if (answer.state !== "kept") throw new Unreadable();
      this.#kept.set(agent, digest);
    } catch (error) {
      // The server stopped serving skills since it was asked: the turn runs without them, as on a server that never did.
      if (!(error instanceof Refused) || error.code !== "feature_unavailable") throw error;
      this.#served = { state: "off", at: this.deps.now() };
    }
  }

  /** Sends the packs the server lacks, `PACKS_AT_ONCE` at a time, telling how many have gone. The first failure ends the send, naming its skill. */
  async #send(on: Requests, agent: HostedAgent, lacking: readonly OwnSkill[]): Promise<void> {
    const queue = [...lacking];
    const progress = { sent: 0, total: queue.length };
    const tell = () => {
      this.#sending.set(agent, { ...progress });
      this.deps.changed?.();
    };
    let failed = false;
    const lane = async (): Promise<void> => {
      while (!failed) {
        const skill = queue.shift();
        if (!skill) return;
        await this.#pack(on, skill).catch((error: unknown) => {
          failed = true;
          throw refusedFor(skill.name, error);
        });
        progress.sent++;
        tell();
      }
    };
    tell();
    try {
      await Promise.all(Array.from({ length: Math.min(PACKS_AT_ONCE, queue.length) }, lane));
    } finally {
      this.#sending.delete(agent);
      this.deps.changed?.();
    }
  }

  /** Sends one pack, once for the agents whose sets lack it at the same time. */
  #pack(on: Requests, skill: OwnSkill): Promise<unknown> {
    const going = this.#packing.get(skill.digest);
    if (going) return going;
    const sent = on.request(SKILL_ROUTES.pack(skill.digest), new RawBody(() => skill.pack())).finally(() => this.#packing.delete(skill.digest));
    this.#packing.set(skill.digest, sent);
    return sent;
  }

  /** Whether the server serves skills, asked once for the sends that wonder at the same time. */
  #serves(on: Requests): Promise<boolean> {
    const served = this.#served;
    if (served && (served.state !== "off" || this.deps.now() - served.at < ASK_AGAIN_MS)) return Promise.resolve(served.state === "on");
    this.#asking ??= this.#ask(on).finally(() => (this.#asking = null));
    return this.#asking;
  }

  async #ask(on: Requests): Promise<boolean> {
    try {
      const capabilities = await on.request(PARITY_ROUTES.capabilities);
      this.#served = capabilities.features.skills?.available ? { state: "on" } : { state: "off", at: this.deps.now() };
    } catch (error) {
      if (!(error instanceof Refused) || error.status !== 404) throw error;
      this.#served = { state: "absent" };
    }
    return this.#served.state === "on";
  }
}

/** The server's refusal of a pack, naming its skill. A skill this Mac could not read already names it, and one out of reach is the session's to say. */
function refusedFor(name: string, error: unknown): unknown {
  if (!(error instanceof Refused) || error.code === "feature_unavailable") return error;
  return new Refused(`Couldn't send your skill ${name}. ${error.message}`, error.status, error.code);
}
