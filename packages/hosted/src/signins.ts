/**
 * Signing an agent in on OpenOrc Cloud, every way through one table: a way takes what the person gives, hands the
 * secret to the server, and keeps it nowhere. What is under way, or the last that failed, is `work`, by agent; the
 * server's list of sign-ins is the account's to read again once one lands.
 *
 *   token  this Mac makes a Claude token (`HostedDeps.mintClaudeToken`) and it goes straight to the server
 *   code   the server starts a Codex device code; the person enters it on OpenAI's page while this asks the server to
 *          finish it, at the pace the server gave, until it connects or runs out
 *   key    an API key typed in, for any agent; OpenCode's names its provider
 *
 * A server that keeps several accounts per agent (`agentAccounts`) takes each way as a new account, called by the name
 * the person gave or by its plan, or as an existing account signed in again (`accountId`); an older server keeps one
 * sign-in per agent, replaced each time.
 */
import type { HostedAgent, RpcParams, SignInWork } from "@openorc/protocol";
import type { HostedDeps } from "./index.js";
import type { Session } from "./session.js";
import { ROUTES } from "./wire.js";

type Connect = RpcParams<"account.signIns.connect">;
/** Where a sign-in lands: the account it signs in again, or a new one by this name. */
type Landing = Pick<Connect, "accountId" | "name">;

interface SignInsDeps extends Pick<HostedDeps, "mintClaudeToken" | "now"> {
  session: Session;
  /** The server keeps several accounts per agent. */
  accounts(): boolean;
  /** The work changed: the windows read the account again. */
  changed(): void;
  /** A sign-in landed or left: the account reads the server's list again. */
  landed(): Promise<void>;
}

const NO_TOKENS = "This device can't make a Claude token. Use an API key.";
const RAN_OUT = "The code ran out. Sign in again.";

export class SignIns {
  readonly #work = new Map<HostedAgent, SignInWork>();
  /** What calls off the attempt under way, by agent. */
  readonly #stops = new Map<HostedAgent, () => void>();

  constructor(private readonly deps: SignInsDeps) {}

  get work(): Partial<Record<HostedAgent, SignInWork>> {
    return Object.fromEntries(this.#work);
  }

  /** Starts a way of signing in. A key resolves once the server took it, or rejects in its words; the others go on in `work`. */
  async connect(input: Connect): Promise<void> {
    this.cancel(input.agent);
    const landing = this.deps.accounts() ? { accountId: input.accountId, name: input.name } : {};
    if (input.way === "key") return this.#key(input.agent, input.key, input.provider, landing);
    if (input.way === "code") return this.#code(landing);
    return this.#token(input.claudeAccountId, landing);
  }

  cancel(agent: HostedAgent): void {
    this.#stops.get(agent)?.();
    this.#stops.delete(agent);
    if (this.#work.delete(agent)) this.deps.changed();
  }

  async remove({ agent, provider, accountId }: RpcParams<"account.signIns.remove">): Promise<void> {
    await this.deps.session.request(accountId && this.deps.accounts() ? ROUTES.removeAccount(accountId) : ROUTES.removeSignIn(agent, provider));
    await this.deps.landed();
  }

  async update({ accountId, name, isDefault }: RpcParams<"account.signIns.update">): Promise<void> {
    await this.deps.session.request(ROUTES.updateAccount(accountId), { ...(name !== undefined && { name }), ...(isDefault && { isDefault }) });
    await this.deps.landed();
  }

  /** Signed out: every attempt stops and nothing of it is remembered. */
  forget(): void {
    for (const stop of this.#stops.values()) stop();
    this.#stops.clear();
    this.#work.clear();
  }

  async #key(agent: HostedAgent, key: string, provider: string | undefined, landing: Landing): Promise<void> {
    const body: Record<string, string> = agent === "claude" ? { kind: "api_key", apiKey: key } : { apiKey: key };
    await this.#send(agent, provider, body, landing);
    await this.deps.landed();
  }

  /** A sign-in handed to the server: the account it signs in again, a new account, or, on an older server, the agent's one. */
  #send(agent: HostedAgent, provider: string | undefined, body: Record<string, string>, { accountId, name }: Landing) {
    if (accountId) return this.deps.session.request(ROUTES.signAccountInAgain(accountId), body);
    if (this.deps.accounts()) return this.deps.session.request(ROUTES.addAccount(agent, provider), { ...body, ...(name && { name }) });
    return this.deps.session.request(ROUTES.setSignIn(agent, provider), body);
  }

  /** The token is made here and handed over as it appears; a cancel ends the command and leaves nothing behind. */
  async #token(claudeAccountId: string | undefined, landing: Landing): Promise<void> {
    if (!this.deps.mintClaudeToken) throw new Error(NO_TOKENS);
    const mint = this.deps.mintClaudeToken(claudeAccountId);
    let live = true;
    this.#start("claude", { state: "waiting", way: "token", ...again(landing) }, () => {
      live = false;
      mint.cancel();
    });
    void mint.token
      .then((token) => this.#send("claude", undefined, { kind: "subscription", token }, landing))
      .then(
        async () => {
          if (live) await this.#done("claude");
        },
        (error: unknown) => {
          if (live) this.#failed("claude", error);
        },
      );
  }

  async #code(landing: Landing): Promise<void> {
    const code = this.deps.accounts()
      ? await this.deps.session.request(ROUTES.startAccountDevice, { ...(landing.name && { name: landing.name }), ...(landing.accountId && { accountId: landing.accountId }) })
      : await this.deps.session.request(ROUTES.startDevice);
    const expiresAt = Date.parse(code.expiresAt);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const waiting = { state: "waiting", way: "code", userCode: code.userCode, verificationUrl: code.verificationUrl, expiresAt, ...again(landing) } as const;
    this.#start("codex", waiting, () => timer && clearTimeout(timer));
    const ask = async (): Promise<void> => {
      if (this.#work.get("codex")?.state !== "waiting") return;
      if (this.deps.now() > expiresAt) return this.#failed("codex", new Error(RAN_OUT));
      try {
        const finish = await this.deps.session.request(ROUTES.finishDevice, { id: code.id });
        if (this.#work.get("codex")?.state !== "waiting") return;
        if (finish.status === "connected") return void (await this.#done("codex"));
        if (finish.status === "expired") return this.#failed("codex", new Error(RAN_OUT));
      } catch (error) {
        return this.#failed("codex", error);
      }
      timer = setTimeout(() => void ask(), code.intervalSeconds * 1000);
    };
    timer = setTimeout(() => void ask(), code.intervalSeconds * 1000);
  }

  #start(agent: HostedAgent, work: SignInWork, stop: () => void): void {
    this.#work.set(agent, work);
    this.#stops.set(agent, stop);
    this.deps.changed();
  }

  async #done(agent: HostedAgent): Promise<void> {
    this.#stops.delete(agent);
    this.#work.delete(agent);
    await this.deps.landed();
    this.deps.changed();
  }

  /** Words for why it failed, kept with the account it signed in again; a cancel (an empty message) leaves no failure behind. */
  #failed(agent: HostedAgent, error: unknown): void {
    this.#stops.delete(agent);
    const words = error instanceof Error ? error.message : String(error);
    const accountId = this.#work.get(agent)?.accountId;
    if (words) this.#work.set(agent, { state: "failed", error: words, ...(accountId && { accountId }) });
    else this.#work.delete(agent);
    this.deps.changed();
  }
}

/** The account a sign-in under way signs in again, for the row it shows on. */
const again = ({ accountId }: Landing) => (accountId ? { accountId } : {});
