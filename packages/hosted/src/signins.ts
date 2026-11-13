/**
 * Signing an agent in on OpenOrc Cloud, every way through one table: a way takes what the person gives, hands the
 * secret to the server, and keeps it nowhere. What is under way, or the last that failed, is `work`, by agent; the
 * server's list of sign-ins is the account's to read again once one lands.
 *
 *   token  this Mac makes a Claude token (`HostedDeps.mintClaudeToken`) and it goes straight to the server
 *   code   the server starts a Codex device code; the person enters it on OpenAI's page while this asks the server to
 *          finish it, at the pace the server gave, until it connects or runs out
 *   key    an API key typed in, for any agent; OpenCode's names its provider
 */
import type { HostedAgent, RpcParams, SignInWork } from "@openorc/protocol";
import type { HostedDeps } from "./index.js";
import type { Session } from "./session.js";
import { ROUTES } from "./wire.js";

type Connect = RpcParams<"account.signIns.connect">;

interface SignInsDeps extends Pick<HostedDeps, "mintClaudeToken" | "now"> {
  session: Session;
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
    if (input.way === "key") return this.#key(input.agent, input.key, input.provider);
    if (input.way === "code") return this.#code();
    return this.#token(input.claudeAccountId);
  }

  cancel(agent: HostedAgent): void {
    this.#stops.get(agent)?.();
    this.#stops.delete(agent);
    if (this.#work.delete(agent)) this.deps.changed();
  }

  async remove(agent: HostedAgent, provider: string | undefined): Promise<void> {
    await this.deps.session.request(ROUTES.removeSignIn(agent, provider));
    await this.deps.landed();
  }

  /** Signed out: every attempt stops and nothing of it is remembered. */
  forget(): void {
    for (const stop of this.#stops.values()) stop();
    this.#stops.clear();
    this.#work.clear();
  }

  async #key(agent: HostedAgent, key: string, provider: string | undefined): Promise<void> {
    const body = agent === "claude" ? { kind: "api_key", apiKey: key } : { apiKey: key };
    await this.deps.session.request(ROUTES.setSignIn(agent, provider), body);
    await this.deps.landed();
  }

  /** The token is made here and handed over as it appears; a cancel ends the command and leaves nothing behind. */
  async #token(claudeAccountId: string | undefined): Promise<void> {
    if (!this.deps.mintClaudeToken) throw new Error(NO_TOKENS);
    const mint = this.deps.mintClaudeToken(claudeAccountId);
    let live = true;
    this.#start("claude", { state: "waiting", way: "token" }, () => {
      live = false;
      mint.cancel();
    });
    void mint.token
      .then((token) => this.deps.session.request(ROUTES.setSignIn("claude"), { kind: "subscription", token }))
      .then(
        async () => {
          if (live) await this.#done("claude");
        },
        (error: unknown) => {
          if (live) this.#failed("claude", error);
        },
      );
  }

  async #code(): Promise<void> {
    const code = await this.deps.session.request(ROUTES.startDevice);
    const expiresAt = Date.parse(code.expiresAt);
    let timer: ReturnType<typeof setTimeout> | null = null;
    this.#start("codex", { state: "waiting", way: "code", userCode: code.userCode, verificationUrl: code.verificationUrl, expiresAt }, () => timer && clearTimeout(timer));
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

  /** Words for why it failed; a cancel (an empty message) leaves no failure behind. */
  #failed(agent: HostedAgent, error: unknown): void {
    this.#stops.delete(agent);
    const words = error instanceof Error ? error.message : String(error);
    if (words) this.#work.set(agent, { state: "failed", error: words });
    else this.#work.delete(agent);
    this.deps.changed();
  }
}
