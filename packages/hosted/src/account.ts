/**
 * The account behind `HostedAccount`: who is signed in and what they pay for.
 *
 * State, written only here:
 *   heard       what the server last answered about the person, their billing, where their cloud threads run, their
 *               agents' sign-ins and their GitHub, with the address it was for, and the sign-ins it refused a turn on
 *               as signed out.
 *               Kept in `deps.kept`. Each part is replaced only by an answer for it.
 *   error       words for the last read that failed for a reason other than reach.
 *
 * `status()` is computed from these and the session each time it is asked. Nothing stores an AccountStatus.
 */
import { openCodeProvider, type AccountProject, type BillingOffers, type BillingPage, type AccountStatus, type HostedAgent, type HostedRefusal, type RpcParams } from "@openorc/protocol";
import { z } from "zod";
import type { HostedAccount, HostedDeps } from "./index.js";
import { OutOfReach, Refused, type Session, type SessionChange } from "./session.js";
import { githubRepoOf, signInKey, toImage, toOffers, toPlan, toSandbox, toSignIns } from "./translate.js";
import { BrowserSignInTrip } from "./browser-sign-in.js";
import { GithubConnect } from "./github.js";
import { Paying } from "./paying.js";
import { SignIns } from "./signins.js";
import { ROUTES, SOCKET, wireBilling, wireGithubRepository, wireHostedSettings, wireSignIn, wireTopics } from "./wire.js";

const keptAnswers = z.object({
  email: z.string(),
  billing: wireBilling.nullable(),
  person: z.object({ name: z.string(), image: z.string().nullable() }).nullable().default(null),
  sandbox: wireHostedSettings.nullable().default(null),
  signIns: z.array(wireSignIn).nullable().default(null),
  /** Sign-ins the server refused a turn on as signed out, by agent and provider, with the `checkedAt` it had then. */
  ended: z.array(z.object({ key: z.string(), checkedAt: z.string().nullable() })).default([]),
  github: z
    .object({ configured: z.boolean(), login: z.string().nullable(), installedOn: z.array(z.string()), repositories: z.array(wireGithubRepository) })
    .nullable()
    .default(null),
});
type Heard = z.infer<typeof keptAnswers>;

/** `cloud`: the repositories the person's spaces have as projects, and a read of them again. */
type AccountDeps = { session: Session; cloud: { repos(): ReadonlySet<string>; reread(): Promise<void> } } & Pick<
  HostedDeps,
  "kept" | "push" | "now" | "mintClaudeToken" | "browser" | "deviceName" | "projects"
>;

export class Account implements HostedAccount {
  #heard: Heard | null = null;
  #error: string | null = null;
  #announced = "";
  readonly #signingIn: BrowserSignInTrip;
  readonly #signIns: SignIns;
  readonly #github: GithubConnect;
  readonly #paying: Paying;

  constructor(private readonly deps: AccountDeps) {
    this.#signingIn = new BrowserSignInTrip({ session: deps.session, browser: deps.browser, deviceName: deps.deviceName, changed: () => this.#announce() });
    this.#signIns = new SignIns({ session: deps.session, mintClaudeToken: deps.mintClaudeToken, now: deps.now, changed: () => this.#announce(), landed: () => this.#refresh() });
    this.#github = new GithubConnect({ session: deps.session, browser: deps.browser, changed: () => this.#announce(), landed: () => this.#landed() });
    this.#paying = new Paying({
      session: deps.session,
      browser: deps.browser,
      now: deps.now,
      billing: () => this.#heard?.billing ?? null,
      reread: () => this.#readBilling(),
      changed: () => this.#announce(),
    });
    deps.session.onChange((change) => this.#changed(change));
    // The person's own topics: what they pay for, their sign-ins and their GitHub, changed elsewhere.
    deps.session.onSocket(SOCKET.changed, (body) => {
      const topics = wireTopics.safeParse(body);
      if (topics.success && topics.data.topics.some((topic) => topic === "billing" || topic === "sign-ins" || topic === "github")) void this.#refresh();
    });
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
    if (!state.signedIn) return { state: "signed-out", signingIn: this.#signingIn.work, ended: state.ended, error: this.#error };
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
      signingIn: this.#signIns.work,
      github: heard?.github ? { ...heard.github, repositories: heard.github.repositories.map((repository) => repository.fullName) } : null,
      connectingGithub: this.#github.work,
      projects: this.#projects(heard?.github?.repositories ?? []),
      paying: this.#paying.work,
      error: this.#error,
    };
  }

  /** This Mac's projects with a GitHub repository, each with where it stands on OpenOrc Cloud. */
  #projects(readable: readonly { fullName: string }[]): AccountProject[] {
    const cloud = this.deps.cloud.repos();
    const reads = new Set(readable.map((repository) => repository.fullName.toLowerCase()));
    return this.deps.projects().flatMap((project): AccountProject[] => {
      const repo = githubRepoOf(project.remote);
      if (!repo) return [];
      if (cloud.has(repo)) return [{ projectId: project.id, repo, cloud: "added" }];
      return [{ projectId: project.id, repo, cloud: reads.has(repo) ? "addable" : "unreadable" }];
    });
  }

  /** Opens the sign-in page in the browser; how it goes shows in `status().signingIn` until the session is kept. */
  async signIn(): Promise<void> {
    this.#error = null;
    await this.#signingIn.start();
  }

  cancelSigningIn(): void {
    this.#signingIn.cancel();
  }

  async signOut(): Promise<void> {
    await this.deps.session.signOut();
    this.#announce();
  }

  /** Chooses where the person's cloud threads run. The server refuses a service it does not run threads on, in words. */
  async setSandbox(service: string | null): Promise<void> {
    const email = this.#signedInAs();
    const settings = await this.deps.session.request(ROUTES.setHostedSettings, { service });
    if (email && this.#signedInAs() === email) this.#hear(email, { sandbox: settings });
  }

  connectSignIn(input: RpcParams<"account.signIns.connect">): Promise<void> {
    return this.#signIns.connect(input);
  }

  cancelSignIn(agent: HostedAgent): void {
    this.#signIns.cancel(agent);
  }

  removeSignIn({ agent, provider }: RpcParams<"account.signIns.remove">): Promise<void> {
    return this.#signIns.remove(agent, provider);
  }

  connectGithub(): Promise<void> {
    return this.#github.connect();
  }

  cancelGithub(): void {
    this.#github.cancel();
  }

  disconnectGithub(): Promise<void> {
    return this.#github.disconnect();
  }

  /** The repository goes to the session's active space, the personal one unless the person chose another; the projects are read again. */
  async addProject(projectId: string): Promise<void> {
    const repo = githubRepoOf(this.deps.projects().find((project) => project.id === projectId)?.remote ?? null);
    if (!repo) throw new Refused("This project has no GitHub repository.");
    const found = this.#heard?.github?.repositories.find((repository) => repository.fullName.toLowerCase() === repo);
    if (!found) throw new Refused(`GitHub doesn't let OpenOrc read ${repo} yet.`);
    await this.deps.session.request(ROUTES.addProjects, { repositories: [{ installationId: found.installationId, repoId: found.repoId }] });
    await this.deps.cloud.reread();
    this.#announce();
  }

  openBilling(page: BillingPage): Promise<void> {
    return this.#paying.open(page);
  }

  leaveBilling(): void {
    this.#paying.leave();
  }

  /** Asked of the server each time, never kept: a price is shown only as the server says it now. */
  async offers(): Promise<BillingOffers | null> {
    if (!this.#signedInAs()) return null;
    const offers = await this.deps.session.request(ROUTES.offers).catch(() => null);
    return offers && toOffers(offers);
  }

  /** The host is closing: nothing is watched any more. */
  close(): void {
    this.#signingIn.forget();
    this.#paying.forget();
  }

  /** A GitHub trip settled: its part and the projects are read again. */
  async #landed(): Promise<void> {
    await Promise.all([this.#refresh(), this.deps.cloud.reread()]);
    this.#announce();
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
    if (this.deps.session.state.signedIn) this.#signingIn.forget();
    else {
      // Before the session's own storage is cleared and before the server hears of it.
      this.#signIns.forget();
      this.#github.forget();
      this.#paying.forget();
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
    const [person, billing, sandbox, signIns, github] = await Promise.allSettled([
      this.deps.session.request(ROUTES.person),
      this.deps.session.request(ROUTES.billing),
      this.deps.session.request(ROUTES.hostedSettings),
      this.deps.session.request(ROUTES.signIns),
      this.#readGithub(),
    ]);
    if (this.#signedInAs() !== email) return;
    if (person.status === "fulfilled" && person.value === null) return void this.deps.session.end("server");
    this.#error = billing.status === "rejected" && !(billing.reason instanceof OutOfReach) ? wordsOf(billing.reason) : null;
    this.#hear(email, {
      ...(person.status === "fulfilled" && person.value && { person: { name: person.value.user.name, image: toImage(person.value.user.image) } }),
      ...(billing.status === "fulfilled" && { billing: billing.value }),
      ...(sandbox.status === "fulfilled" && { sandbox: sandbox.value }),
      ...(signIns.status === "fulfilled" && { signIns: signIns.value }),
      ...(github.status === "fulfilled" && { github: github.value }),
    });
  }

  /** Reads billing alone, as a page opened to pay is watched. A failed read keeps what was heard. */
  async #readBilling(): Promise<void> {
    const email = this.#signedInAs();
    if (!email) return;
    const billing = await this.deps.session.request(ROUTES.billing).catch(() => null);
    if (billing && this.#signedInAs() === email) this.#hear(email, { billing });
  }

  /**
   * The person's GitHub for their space: the app's installations and the account they linked, and the repositories
   * those let OpenOrc read. What only an admin of the space may read reads as none for anyone else.
   */
  async #readGithub(): Promise<NonNullable<Heard["github"]>> {
    const adminOnly = <T>(read: Promise<T>, none: T) =>
      read.catch((error: unknown) => {
        if (error instanceof Refused) return none;
        throw error;
      });
    const [installed, link, repositories] = await Promise.all([
      adminOnly(this.deps.session.request(ROUTES.github), { configured: true, installations: [] }),
      this.deps.session.request(ROUTES.githubLink),
      adminOnly(this.deps.session.request(ROUTES.githubRepositories), []),
    ]);
    return { configured: installed.configured, login: link.account?.login ?? null, installedOn: installed.installations.map((each) => each.accountLogin), repositories };
  }

  /** Puts what the server just answered for `email` beside what it said before, keeps it, and tells the windows. */
  #hear(email: string, parts: Partial<Omit<Heard, "email">>): void {
    const before = this.#heard?.email === email ? this.#heard : { email, billing: null, person: null, sandbox: null, signIns: null, ended: [], github: null };
    this.#heard = { ...before, ...parts };
    if (parts.billing) this.#paying.heard(parts.billing);
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
