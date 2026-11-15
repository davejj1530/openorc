/**
 * The person's own skills, made the server's before a turn of theirs may start, so the agent in the cloud finds what
 * it finds on this device. The host says what the person has for an agent, each skill by its name and the digest of
 * its pack; the server keeps a pack once, so only one it lacks is ever sent, and a set it already keeps costs nothing.
 *
 * Nothing is sent to a server that does not serve skills: one with no capabilities at all is asked once a session,
 * one that says they are not available is asked again after a minute. A failure is the caller's to show: the message
 * it was sending stays where it is, and sending it again tries again.
 */
import { isHostedAgent, type HostedAgent } from "@openorc/protocol";
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

  constructor(private readonly deps: { session: Session; own: OwnSkills | undefined; now(): number }) {}

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
        for (const missing of answer.digests) {
          const skill = skills.find((each) => each.digest === missing);
          if (!skill) throw new Unreadable();
          await on.request(SKILL_ROUTES.pack(missing), new RawBody(() => skill.pack()));
        }
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

  async #serves(on: Requests): Promise<boolean> {
    const served = this.#served;
    if (served && (served.state !== "off" || this.deps.now() - served.at < ASK_AGAIN_MS)) return served.state === "on";
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
