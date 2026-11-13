/**
 * The account behind `HostedAccount`: who is signed in and what they pay for.
 *
 * State, written only here:
 *   heard       what the server last answered about the person, their billing, where their cloud threads run and their
 *               agents' sign-ins, with the address it was for, and the sign-ins it refused a turn on as signed out.
 *               Kept in `deps.kept`. Each part is replaced only by an answer for it.
 *   codeSent    the address a code was last sent to, and when.
 *   error       words for the last read that failed for a reason other than reach.
 *
 * `status()` is computed from these and the session each time it is asked. Nothing stores an AccountStatus.
 */
import { openCodeProvider, type AccountStatus, type HostedRefusal } from "@openorc/protocol";
import { z } from "zod";
import type { HostedAccount, HostedDeps } from "./index.js";
import { OutOfReach, type Session, type SessionChange } from "./session.js";
import { signInKey, toImage, toPlan, toSandbox, toSignIns } from "./translate.js";
import { ROUTES, wireBilling, wireHostedSettings, wireSignIn } from "./wire.js";

/** How long Settings keeps asking for the code it sent; the server's code lasts five minutes. */
const CODE_REMEMBERED_MS = 10 * 60_000;

const keptAnswers = z.object({
  email: z.string(),
  billing: wireBilling.nullable(),
  person: z.object({ name: z.string(), image: z.string().nullable() }).nullable().default(null),
  sandbox: wireHostedSettings.nullable().default(null),
  signIns: z.array(wireSignIn).nullable().default(null),
  /** Sign-ins the server refused a turn on as signed out, by agent and provider, with the `checkedAt` it had then. */
  ended: z.array(z.object({ key: z.string(), checkedAt: z.string().nullable() })).default([]),
});
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
      this.#error = wordsOf(error);
    }
    const kept = parseKept(this.deps.kept.load("account"));
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
    const heard = this.#heard?.email === state.email ? this.#heard : null;
    const { plan, hours } = heard?.billing ? toPlan(heard.billing) : { plan: { pro: false as const }, hours: null };
    return {
      state: "signed-in",
      email: state.email,
      name: heard?.person?.name ?? null,
      image: heard?.person?.image ?? null,
      reach: state.reach,
      plan,
      hours,
      sandbox: heard?.sandbox ? toSandbox(heard.sandbox) : null,
      signIns: heard?.signIns ? toSignIns(heard.signIns, heard.ended) : null,
      error: this.#error,
    };
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

  /** Chooses where the person's cloud threads run. The server refuses a service it does not run threads on, in words. */
  async setSandbox(service: string | null): Promise<void> {
    const email = this.#signedInAs();
    const settings = await this.deps.session.request(ROUTES.setHostedSettings, { service });
    if (email && this.#signedInAs() === email) this.#hear(email, { sandbox: settings });
  }

  /**
   * The server refused a turn: read the account again, so the card above the composer says why. A sign-in it found
   * signed out is marked ended until it is set again, which the list alone cannot tell.
   */
  refused(refusal: HostedRefusal, settings: { agent: string; model: string | null }): void {
    const email = this.#signedInAs();
    if (email && refusal === "signed_out" && this.#heard) {
      const key = signInKey(settings.agent, settings.agent === "opencode" ? openCodeProvider(settings.model) : null);
      const row = this.#heard.signIns?.find((each) => signInKey(each.agent, each.agent === "opencode" ? each.provider : null) === key);
      this.#hear(email, { ended: [...this.#heard.ended.filter((each) => each.key !== key), { key, checkedAt: row?.checkedAt ?? null }] });
    }
    void this.#refresh();
  }

  #changed(change: SessionChange): void {
    if (!this.deps.session.state.signedIn) {
      // Before the session's own storage is cleared and before the server hears of it.
      this.#heard = null;
      this.#error = null;
      this.deps.kept.save("account", null);
    }
    if (change === "connected") void this.#refresh();
    this.#announce();
  }

  /**
   * Reads the person, billing and where their threads run, together. A failed read keeps what was heard for its part;
   * an answer for a session that ended meanwhile is dropped. The server answering no person means the session is gone.
   */
  async #refresh(): Promise<void> {
    const email = this.#signedInAs();
    if (!email) return;
    const [person, billing, sandbox, signIns] = await Promise.allSettled([
      this.deps.session.request(ROUTES.person),
      this.deps.session.request(ROUTES.billing),
      this.deps.session.request(ROUTES.hostedSettings),
      this.deps.session.request(ROUTES.signIns),
    ]);
    if (this.#signedInAs() !== email) return;
    if (person.status === "fulfilled" && person.value === null) return void this.deps.session.end("server");
    this.#error = billing.status === "rejected" && !(billing.reason instanceof OutOfReach) ? wordsOf(billing.reason) : null;
    this.#hear(email, {
      ...(person.status === "fulfilled" && person.value && { person: { name: person.value.user.name, image: toImage(person.value.user.image) } }),
      ...(billing.status === "fulfilled" && { billing: billing.value }),
      ...(sandbox.status === "fulfilled" && { sandbox: sandbox.value }),
      ...(signIns.status === "fulfilled" && { signIns: signIns.value }),
    });
  }

  /** Puts what the server just answered for `email` beside what it said before, keeps it, and tells the windows. */
  #hear(email: string, parts: Partial<Omit<Heard, "email">>): void {
    const before = this.#heard?.email === email ? this.#heard : { email, billing: null, person: null, sandbox: null, signIns: null, ended: [] };
    this.#heard = { ...before, ...parts };
    if (Object.keys(parts).length) this.deps.kept.save("account", JSON.stringify(this.#heard));
    this.#announce();
  }

  #signedInAs(): string | null {
    const state = this.deps.session.state;
    return state.signedIn ? state.email : null;
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

function wordsOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
