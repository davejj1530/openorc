/**
 * The stand-in's agent sign-ins, answered as the server does:
 *   a Claude token or key, a Codex key and an OpenCode provider's key are kept, with a new `checkedAt`; a secret the
 *   vendor refuses (here: one that starts with "bad") is 400 in the vendor's words
 *   a Codex device code is started, then each finish answers pending until the person approves it (`approveDevice`),
 *   connected once, and expired after that or for someone else's code
 *   removing one the person does not have changes nothing
 * Behind the `agentAccounts` capability the server keeps several accounts per agent (and provider, for OpenCode), as
 * its agent-sign-ins.ts does: each added one is new, named by the person or by its plan, numbered when that is taken
 * ("Claude Max 2"); the first is the default, and removing the default makes the oldest left the default. The old
 * routes act on the default account. Without the capability, one sign-in per agent, replaced each time, and the list
 * names no account.
 */
import { randomBytes } from "node:crypto";
import type { StandInSignIn } from "./stand-in.js";

type Reply = { status: number; body: unknown };
type Row = Required<Pick<StandInSignIn, "agent" | "provider" | "label">>;
/** Where a sign-in lands: an account signed in again, a new account by this name, or, on the old routes, the default. */
type Landing = { accountId?: string; name?: string; add?: boolean };

const CLAUDE_REFUSED = {
  subscription: "Anthropic refused that token. Run `claude setup-token` again and paste the token it prints.",
  api_key: "Anthropic refused that API key. Check it in the Claude Console and paste it again.",
} as const;
const OPENAI_REFUSED = "OpenAI refused that API key. Check it on OpenAI's API keys page and paste it again.";
const NOT_HERE = "That account isn't here.";
const BUSY = "A turn is running on this account. Wait for it to finish, or stop it, before removing the account.";

const refused = (message: string, status = 400): Reply => ({ status, body: { message, statusCode: status } });
const vendorTakes = (secret: unknown) => typeof secret === "string" && secret.trim().length > 0 && !secret.startsWith("bad");

export class StandInSignIns {
  readonly #devices = new Map<string, { who: string; approved: boolean; userCode: string; landing: Landing }>();
  /** Every secret the server was handed, by agent, so a test can see it went to the server and nowhere else. */
  readonly secrets: { agent: string; secret: string }[] = [];
  /** Accounts a turn runs on now, which the server will not remove. */
  readonly busy = new Set<string>();

  constructor(
    private readonly signIns: Map<string, StandInSignIn[]>,
    /** The server keeps several accounts per agent. */
    private readonly accounts: () => boolean,
  ) {}

  /** The routes under /agent-sign-ins, for the person `who`; null for any other. */
  route(method: string, path: string, who: string, body: Record<string, unknown>): Reply | null {
    if (method === "GET" && path === "/agent-sign-ins") return { status: 200, body: this.#rows(who).map((row) => this.#listed(row)) };
    const opencode = /^\/agent-sign-ins\/opencode\/([a-z0-9][a-z0-9-]{0,63})$/.exec(path);
    if (opencode && method === "PUT") return this.#keep(who, { agent: "opencode", provider: opencode[1]!, label: "API key" }, body["apiKey"], null, {});
    if (opencode && method === "DELETE") return this.#removeDefault(who, "opencode", opencode[1]!);
    const routes: Record<string, () => Reply> = {
      "PUT /agent-sign-ins/claude": () => this.#claude(who, body, {}),
      "PUT /agent-sign-ins/codex": () => this.#keep(who, { agent: "codex", provider: "openai", label: "API key" }, body["apiKey"], OPENAI_REFUSED, {}),
      "POST /agent-sign-ins/codex/device/start": () => this.#startDevice(who, {}),
      "POST /agent-sign-ins/codex/device/finish": () => this.#finishDevice(who, String(body["id"] ?? "")),
      "DELETE /agent-sign-ins/claude": () => this.#removeDefault(who, "claude", "anthropic"),
      "DELETE /agent-sign-ins/codex": () => this.#removeDefault(who, "codex", "openai"),
    };
    return routes[`${method} ${path}`]?.() ?? (this.accounts() ? this.#accountRoute(method, path, who, body) : null);
  }

  /** The person approves the device code they were shown, on OpenAI's page. */
  approveDevice(who: string): void {
    for (const device of this.#devices.values()) if (device.who === who) device.approved = true;
  }

  #accountRoute(method: string, path: string, who: string, body: Record<string, unknown>): Reply | null {
    const named = nameOf(body);
    if (typeof named === "object") return named;
    return method === "POST" ? this.#add(path, who, body, named) : this.#onAccount(method, path, who, body, named);
  }

  /** A new account for an agent, or a Codex device code for one (or for an account to sign in again). */
  #add(path: string, who: string, body: Record<string, unknown>, name: string | undefined): Reply | null {
    const add = { add: true, ...(name && { name }) };
    const opencode = /^\/agent-sign-ins\/accounts\/opencode\/([a-z0-9][a-z0-9-]{0,63})$/.exec(path);
    if (opencode) return this.#keep(who, { agent: "opencode", provider: opencode[1]!, label: "API key" }, body["apiKey"], null, add);
    if (path === "/agent-sign-ins/accounts/claude") return this.#claude(who, body, add);
    if (path === "/agent-sign-ins/accounts/codex") return this.#keep(who, { agent: "codex", provider: "openai", label: "API key" }, body["apiKey"], OPENAI_REFUSED, add);
    if (path !== "/agent-sign-ins/accounts/codex/device/start") return null;
    const accountId = typeof body["accountId"] === "string" ? body["accountId"] : undefined;
    return this.#startDevice(who, accountId ? { accountId } : add);
  }

  /** One of the person's accounts: signed in again, renamed or made the default, or removed. */
  #onAccount(method: string, path: string, who: string, body: Record<string, unknown>, name: string | undefined): Reply | null {
    const account = /^\/agent-sign-ins\/accounts\/([^/]+)(\/sign-in)?$/.exec(path);
    if (!account) return null;
    const id = decodeURIComponent(account[1]!);
    const row = this.#rows(who).find((each) => each.id === id);
    if (!row) return refused(NOT_HERE, 404);
    if (account[2]) return method === "PUT" ? this.#again(who, row, body) : null;
    if (method === "PATCH") return this.#update(who, row, name, body["isDefault"] === true);
    if (method === "DELETE") return this.busy.has(id) ? refused(BUSY, 409) : this.#remove(who, row);
    return null;
  }

  #again(who: string, row: StandInSignIn, body: Record<string, unknown>): Reply {
    if (row.agent === "claude") return this.#claude(who, body, { accountId: row.id });
    return this.#keep(who, row as Row, body["apiKey"], row.agent === "codex" ? OPENAI_REFUSED : null, { accountId: row.id });
  }

  #claude(who: string, body: Record<string, unknown>, landing: Landing): Reply {
    const kind = body["kind"] === "api_key" ? "api_key" : "subscription";
    const secret = kind === "api_key" ? body["apiKey"] : body["token"];
    return this.#keep(who, { agent: "claude", provider: "anthropic", label: kind === "api_key" ? "API key" : "Claude Max" }, secret, CLAUDE_REFUSED[kind], landing);
  }

  /** Keeps a sign-in where it lands, once the vendor takes it: a new account, the account signed in again, or the default. */
  #keep(who: string, row: Row, secret: unknown, refusal: string | null, landing: Landing): Reply {
    if (typeof secret !== "string" || !secret.trim()) return refused("Paste the provider's API key.");
    if (refusal && !vendorTakes(secret)) return refused(refusal);
    this.secrets.push({ agent: row.agent, secret });
    const rows = this.#rows(who);
    const checkedAt = new Date().toISOString();
    const sameAgent = rows.filter((each) => same(each, row.agent, row.provider));
    const target = landingOf(rows, sameAgent, landing);
    const kept: StandInSignIn = target
      ? { ...target, label: row.label, checkedAt, ended: false }
      : { ...row, id: newId(), name: landing.name ?? numbered(row.label, sameAgent), isDefault: sameAgent.length === 0, checkedAt };
    this.signIns.set(who, target ? rows.map((each) => (each === target ? kept : each)) : [...rows, kept]);
    return { status: target || !landing.add ? 200 : 201, body: this.#listed(kept) };
  }

  #update(who: string, row: StandInSignIn, name: string | undefined, isDefault: boolean): Reply {
    if (name === undefined && !isDefault) return refused("Say what changes.");
    const rows = this.#rows(who).map((each) => {
      if (each === row) return { ...each, ...(name && { name }), ...(isDefault && { isDefault: true }) };
      return isDefault && same(each, row.agent, row.provider) ? { ...each, isDefault: false } : each;
    });
    this.signIns.set(who, rows);
    return { status: 200, body: this.#listed(rows.find((each) => each.id === row.id)!) };
  }

  /** Removes an account; when it was the default, the oldest left of that agent (and provider) becomes the default. */
  #remove(who: string, row: StandInSignIn): Reply {
    const left = this.#rows(who).filter((each) => each !== row);
    const heir = row.isDefault ? left.find((each) => same(each, row.agent, row.provider)) : undefined;
    this.signIns.set(
      who,
      left.map((each) => (each === heir ? { ...each, isDefault: true } : each)),
    );
    return { status: 204, body: null };
  }

  #removeDefault(who: string, agent: string, provider: string): Reply {
    const row = this.#rows(who).find((each) => same(each, agent, provider) && each.isDefault);
    return row ? this.#remove(who, row) : { status: 204, body: null };
  }

  #startDevice(who: string, landing: Landing): Reply {
    const id = randomBytes(24).toString("base64url");
    const userCode = `${randomBytes(2).toString("hex").toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
    this.#devices.set(id, { who, approved: false, userCode, landing });
    return { status: 200, body: { id, userCode, verificationUrl: "https://auth.openai.com/codex/device", intervalSeconds: 1, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() } };
  }

  #finishDevice(who: string, id: string): Reply {
    const device = this.#devices.get(id);
    if (!device || device.who !== who) return { status: 200, body: { status: "expired" } };
    if (!device.approved) return { status: 200, body: { status: "pending" } };
    this.#devices.delete(id);
    const kept = this.#keep(who, { agent: "codex", provider: "openai", label: "ChatGPT Plus" }, "device-tokens", null, device.landing);
    return { status: 200, body: { status: "connected", signIn: kept.body } };
  }

  /** The person's sign-ins, each an account with an id, the first of each agent (and provider) its default. */
  #rows(who: string): StandInSignIn[] {
    const rows = this.signIns.get(who) ?? [];
    const seen = new Set<string>();
    const accounts = rows.map((row) => {
      const provider = row.provider ?? (row.agent === "codex" ? "openai" : "anthropic");
      const key = `${row.agent}:${provider}`;
      const first = !seen.has(key);
      seen.add(key);
      return row.id ? row : { ...row, provider, id: newId(), name: row.name ?? row.label ?? "Subscription", isDefault: row.isDefault ?? first };
    });
    if (accounts.some((row, i) => row !== rows[i])) this.signIns.set(who, accounts);
    return accounts;
  }

  /** A sign-in as GET /agent-sign-ins lists it, never a secret; the account's id, name and default only behind the capability. */
  #listed(row: StandInSignIn) {
    const listed = {
      agent: row.agent,
      kind: row.label === "API key" ? "api_key" : "subscription",
      provider: row.provider ?? (row.agent === "codex" ? "openai" : "anthropic"),
      label: row.label ?? "Subscription",
      checkedAt: row.checkedAt ?? new Date(0).toISOString(),
      expiresAt: null,
    };
    return this.accounts() ? { ...listed, id: row.id, name: row.name, isDefault: row.isDefault ?? false } : listed;
  }
}

/** The account a sign-in replaces: the one signed in again, none for a new account, else the agent's default. */
function landingOf(rows: readonly StandInSignIn[], sameAgent: readonly StandInSignIn[], landing: Landing): StandInSignIn | undefined {
  if (landing.accountId) return rows.find((each) => each.id === landing.accountId);
  return landing.add ? undefined : sameAgent.find((each) => each.isDefault);
}

/** The name a request gives an account, trimmed; a refusal in the server's words for one it does not take. */
function nameOf(body: Record<string, unknown>): string | undefined | Reply {
  if (typeof body["name"] !== "string") return undefined;
  const name = body["name"].trim();
  if (!name) return refused("Give the account a name.");
  return name.length > 40 ? refused("Keep the name under 40 characters.") : name;
}

/** One account per agent's plan name, numbered after the first: "Claude Max", "Claude Max 2". */
function numbered(label: string, taken: readonly StandInSignIn[]): string {
  const names = new Set(taken.map((row) => row.name));
  if (!names.has(label)) return label;
  for (let n = 2; ; n++) if (!names.has(`${label} ${n}`)) return `${label} ${n}`;
}

const newId = () => `account-${randomBytes(6).toString("hex")}`;

function same(row: StandInSignIn, agent: string, provider: string | undefined): boolean {
  return row.agent === agent && (row.provider ?? (row.agent === "codex" ? "openai" : "anthropic")) === (provider ?? (agent === "codex" ? "openai" : "anthropic"));
}
