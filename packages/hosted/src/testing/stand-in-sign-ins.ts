/**
 * The stand-in's agent sign-in writes, answered as the server does:
 *   a Claude token or key, a Codex key and an OpenCode provider's key are kept in place of the agent's (and provider's)
 *   one, with a new `checkedAt`; a secret the vendor refuses (here: one that starts with "bad") is 400 in the vendor's words
 *   a Codex device code is started, then each finish answers pending until the person approves it (`approveDevice`),
 *   connected once, and expired after that or for someone else's code
 *   removing one the person does not have changes nothing
 */
import { randomBytes } from "node:crypto";
import type { StandInSignIn } from "./stand-in.js";

type Reply = { status: number; body: unknown };

const CLAUDE_REFUSED = {
  subscription: "Anthropic refused that token. Run `claude setup-token` again and paste the token it prints.",
  api_key: "Anthropic refused that API key. Check it in the Claude Console and paste it again.",
} as const;
const OPENAI_REFUSED = "OpenAI refused that API key. Check it on OpenAI's API keys page and paste it again.";

const refused = (message: string): Reply => ({ status: 400, body: { message, statusCode: 400 } });
const vendorTakes = (secret: unknown) => typeof secret === "string" && secret.trim().length > 0 && !secret.startsWith("bad");

export class StandInSignIns {
  readonly #devices = new Map<string, { who: string; approved: boolean; userCode: string }>();
  /** Every secret the server was handed, by agent, so a test can see it went to the server and nowhere else. */
  readonly secrets: { agent: string; secret: string }[] = [];

  constructor(private readonly signIns: Map<string, StandInSignIn[]>) {}

  /** The routes under /agent-sign-ins that write, for the person `who`; null for any other. */
  route(method: string, path: string, who: string, body: Record<string, unknown>): Reply | null {
    const opencode = /^\/agent-sign-ins\/opencode\/([a-z0-9][a-z0-9-]{0,63})$/.exec(path);
    if (opencode && method === "PUT") return this.#keep(who, { agent: "opencode", provider: opencode[1]!, label: "API key" }, body["apiKey"], null);
    if (opencode && method === "DELETE") return this.#remove(who, "opencode", opencode[1]!);
    const routes: Record<string, () => Reply> = {
      "PUT /agent-sign-ins/claude": () => this.#claude(who, body),
      "PUT /agent-sign-ins/codex": () => this.#keep(who, { agent: "codex", provider: "openai", label: "API key" }, body["apiKey"], OPENAI_REFUSED),
      "POST /agent-sign-ins/codex/device/start": () => this.#startDevice(who),
      "POST /agent-sign-ins/codex/device/finish": () => this.#finishDevice(who, String(body["id"] ?? "")),
      "DELETE /agent-sign-ins/claude": () => this.#remove(who, "claude", null),
      "DELETE /agent-sign-ins/codex": () => this.#remove(who, "codex", null),
    };
    return routes[`${method} ${path}`]?.() ?? null;
  }

  /** The person approves the device code they were shown, on OpenAI's page. */
  approveDevice(who: string): void {
    for (const device of this.#devices.values()) if (device.who === who) device.approved = true;
  }

  #claude(who: string, body: Record<string, unknown>): Reply {
    const kind = body["kind"] === "api_key" ? "api_key" : "subscription";
    const secret = kind === "api_key" ? body["apiKey"] : body["token"];
    return this.#keep(who, { agent: "claude", provider: "anthropic", label: kind === "api_key" ? "API key" : "Claude Max" }, secret, CLAUDE_REFUSED[kind]);
  }

  /** Keeps a sign-in in place of the person's one for that agent and provider, once the vendor takes it. */
  #keep(who: string, row: Required<Pick<StandInSignIn, "agent" | "provider" | "label">>, secret: unknown, refusal: string | null): Reply {
    if (typeof secret !== "string" || !secret.trim()) return refused("Paste the provider's API key.");
    if (refusal && !vendorTakes(secret)) return refused(refusal);
    this.secrets.push({ agent: row.agent, secret });
    const kept: StandInSignIn = { ...row, checkedAt: new Date().toISOString() };
    this.signIns.set(who, [...(this.signIns.get(who) ?? []).filter((each) => !same(each, row.agent, row.provider)), kept]);
    return {
      status: 200,
      body: { agent: row.agent, kind: row.label === "API key" ? "api_key" : "subscription", provider: row.provider, label: row.label, checkedAt: kept.checkedAt, expiresAt: null },
    };
  }

  #remove(who: string, agent: string, provider: string | null): Reply {
    this.signIns.set(
      who,
      (this.signIns.get(who) ?? []).filter((each) => !same(each, agent, provider ?? undefined)),
    );
    return { status: 204, body: null };
  }

  #startDevice(who: string): Reply {
    const id = randomBytes(24).toString("base64url");
    const userCode = `${randomBytes(2).toString("hex").toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
    this.#devices.set(id, { who, approved: false, userCode });
    return { status: 200, body: { id, userCode, verificationUrl: "https://auth.openai.com/codex/device", intervalSeconds: 1, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() } };
  }

  #finishDevice(who: string, id: string): Reply {
    const device = this.#devices.get(id);
    if (!device || device.who !== who) return { status: 200, body: { status: "expired" } };
    if (!device.approved) return { status: 200, body: { status: "pending" } };
    this.#devices.delete(id);
    const kept = this.#keep(who, { agent: "codex", provider: "openai", label: "ChatGPT Plus" }, "device-tokens", null);
    return { status: 200, body: { status: "connected", signIn: kept.body } };
  }
}

/** One sign-in per agent, and per provider for OpenCode. */
function same(row: StandInSignIn, agent: string, provider: string | undefined): boolean {
  return row.agent === agent && (agent !== "opencode" || row.provider === provider);
}
