/**
 * The account behind `HostedAccount`: who is signed in and what they pay for.
 *
 * State, written only here:
 *   heard       what the server last answered for billing, with the address it was for. Kept in `deps.kept`.
 *   codeSent    the address a code was last sent to, and when.
 *   error       words for the last read that failed for a reason other than reach.
 *
 * `status()` is computed from these and the session each time it is asked. Nothing stores an AccountStatus.
 */
import type { AccountStatus } from "@openorc/protocol";
import { z } from "zod";
import type { HostedAccount, HostedDeps } from "./index.js";
import { OutOfReach, type Session, type SessionChange } from "./session.js";
import { toPlan } from "./translate.js";
import { ROUTES, wireBilling, type WireBilling } from "./wire.js";

/** How long Settings keeps asking for the code it sent; the server's code lasts five minutes. */
const CODE_REMEMBERED_MS = 10 * 60_000;

const keptAnswers = z.object({ email: z.string(), billing: wireBilling });
type Heard = z.infer<typeof keptAnswers>;

type AccountDeps = { session: Session } & Pick<HostedDeps, "kept" | "push" | "now">;

export class Account implements HostedAccount {
  #heard: Heard | null = null;
  #codeSent: { email: string; at: number } | null = null;
  #error: string | null = null;
  #announced = "";

  constructor(private readonly deps: AccountDeps) {
    deps.session.onChange((change) => this.#changed(change));
  }

  /** Reads the stored session, then what was last heard for it. A session that cannot be read is signed out, with words. */
  async start(): Promise<void> {
    try {
      await this.deps.session.start();
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
    }
    const kept = parseKept(this.deps.kept.load());
    const state = this.deps.session.state;
    if (kept && state.signedIn && kept.email === state.email) this.#heard = kept;
    this.#announce();
  }

  status(): AccountStatus {
    const state = this.deps.session.state;
    if (!state.signedIn) {
      const codeSent = this.#codeSent && this.deps.now() - this.#codeSent.at < CODE_REMEMBERED_MS ? this.#codeSent.email : null;
      return { state: "signed-out", codeSentTo: codeSent, ended: state.ended, error: this.#error };
    }
    const billing = this.#heard?.email === state.email ? this.#heard.billing : null;
    const { plan, hours } = billing ? toPlan(billing) : { plan: { pro: false as const }, hours: null };
    return { state: "signed-in", email: state.email, reach: state.reach, plan, hours, error: this.#error };
  }

  /** The server's refusals read as its words: not invited, too many codes. */
  async sendCode(email: string): Promise<void> {
    await this.deps.session.anonymous(ROUTES.sendCode, { email, type: "sign-in" });
    this.#codeSent = { email, at: this.deps.now() };
    this.#error = null;
    this.#announce();
  }

  /** Rejects with the server's words for a wrong or expired code, keeping nothing. Signing in as another address signs the current one out first. */
  async signIn(email: string, code: string): Promise<void> {
    const state = this.deps.session.state;
    if (state.signedIn && state.email === email) return;
    if (state.signedIn) await this.signOut();
    await this.deps.session.signIn(email, code);
    this.#codeSent = null;
    this.#error = null;
    await this.#refresh();
  }

  async signOut(): Promise<void> {
    this.#codeSent = null;
    await this.deps.session.signOut();
    this.#announce();
  }

  #changed(change: SessionChange): void {
    if (!this.deps.session.state.signedIn) {
      // Before the session's own storage is cleared and before the server hears of it.
      this.#heard = null;
      this.#error = null;
      this.deps.kept.save(null);
    }
    if (change === "connected") void this.#refresh();
    this.#announce();
  }

  /** Reads billing again. A failed read keeps what was heard; an answer for a session that ended meanwhile is dropped. */
  async #refresh(): Promise<void> {
    const before = this.deps.session.state;
    if (!before.signedIn) return;
    const same = () => {
      const now = this.deps.session.state;
      return now.signedIn && now.email === before.email;
    };
    let billing: WireBilling;
    try {
      billing = await this.deps.session.request(ROUTES.billing);
    } catch (error) {
      if (same() && !(error instanceof OutOfReach)) this.#error = error instanceof Error ? error.message : String(error);
      this.#announce();
      return;
    }
    if (!same()) return;
    this.#heard = { email: before.email, billing };
    this.#error = null;
    this.deps.kept.save(JSON.stringify(this.#heard));
    this.#announce();
  }

  /** Tells the windows when what `status()` answers changed. */
  #announce(): void {
    const now = JSON.stringify(this.status());
    if (now === this.#announced) return;
    this.#announced = now;
    this.deps.push({ type: "invalidate", keys: ["account"] });
  }
}

function parseKept(json: string | null): Heard | null {
  if (!json) return null;
  try {
    const parsed = keptAnswers.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
