import path from "node:path";
import type { CloudProviderId } from "@openorc/db";
import { held, OUTSIDE_THE_SANDBOX, type CloudRunWho, type CloudSignIn, type TurnSignIn } from "./cloud-agents.js";
import type { ProtectedSecretStore } from "./extraction-credentials.js";

/**
 * Where each provider OpenCode calls takes its key, so the sandbox's firewall can add it there: the host, the header
 * its AI SDK provider sends, and the scheme before the key.
 */
const PROVIDER_APIS: Record<string, { domain: string; header: string; scheme?: string }> = {
  anthropic: { domain: "api.anthropic.com", header: "x-api-key" },
  openai: { domain: "api.openai.com", header: "authorization", scheme: "Bearer" },
  openrouter: { domain: "openrouter.ai", header: "authorization", scheme: "Bearer" },
  google: { domain: "generativelanguage.googleapis.com", header: "x-goog-api-key" },
  groq: { domain: "api.groq.com", header: "authorization", scheme: "Bearer" },
  mistral: { domain: "api.mistral.ai", header: "authorization", scheme: "Bearer" },
  xai: { domain: "api.x.ai", header: "authorization", scheme: "Bearer" },
  deepseek: { domain: "api.deepseek.com", header: "authorization", scheme: "Bearer" },
};

/** OpenCode's own provider, whose free models need no key. */
const FREE = "opencode";
/** How the providers people most often add are written; any other reads as OpenCode names it. */
const NAMES: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter", google: "Google", groq: "Groq", mistral: "Mistral", xai: "xAI", deepseek: "DeepSeek" };
export const providerName = (provider: string): string => NAMES[provider] ?? provider;
const UNREADABLE = "Cannot access protected storage for OpenCode's cloud keys. Unlock your OS keychain or secret service and retry.";

type Stored = Record<string, { key: string; createdAt: number }>;

/** The provider a model id `provider/model` names; null for an id without one. */
export const providerOf = (model: string | null): string | null => (model?.includes("/") ? model.slice(0, model.indexOf("/")) : null);

/**
 * OpenCode's provider API keys for the cloud, entered for the cloud and kept in protected storage, one per provider.
 * Never this Mac's OpenCode credentials: OpenCode hands none out, and a cloud-only key is revoked on its own.
 */
export class OpenCodeCloudKeys {
  private cache: Stored | undefined;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: ProtectedSecretStore | undefined,
    private readonly changed: () => void = () => undefined,
  ) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation, operation);
    this.pending = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<Stored> {
    if (this.cache) return this.cache;
    if (!this.store) return (this.cache = {});
    let raw: string | null;
    try {
      raw = await this.store.load();
    } catch {
      throw new Error(UNREADABLE);
    }
    this.cache = raw ? (JSON.parse(raw) as Stored) : {};
    return this.cache;
  }

  private async write(next: Stored): Promise<void> {
    if (!this.store) throw new Error("This build keeps no OpenCode keys for the cloud.");
    await this.store.save(JSON.stringify(next));
    this.cache = next;
    this.changed();
  }

  /** The providers that have a key, never the keys. */
  async providers(): Promise<string[]> {
    return Object.keys(await this.read()).sort();
  }

  async key(provider: string): Promise<string | null> {
    return (await this.read())[provider]?.key ?? null;
  }

  /** Every key, for a cloud brain's sealed handover. */
  async all(): Promise<{ provider: string; key: string }[]> {
    return Object.entries(await this.read()).map(([provider, { key }]) => ({ provider, key }));
  }

  save(provider: string, key: string): Promise<void> {
    return this.serialize(async () => this.write({ ...(await this.read()), [provider]: { key, createdAt: Date.now() } }));
  }

  remove(provider: string): Promise<void> {
    return this.serialize(async () => {
      const { [provider]: _gone, ...rest } = await this.read();
      await this.write(rest);
    });
  }

  /** On a cloud brain: exactly the keys the Mac handed over, replacing any before. */
  adopt(keys: { provider: string; key: string }[]): Promise<void> {
    return this.serialize(async () => this.write(Object.fromEntries(keys.map(({ provider, key }) => [provider, { key, createdAt: Date.now() }]))));
  }
}

/**
 * OpenCode in a cloud sandbox: its own database under the runner's folder, never anyone's, and for each turn only the
 * key of the provider serving the thread's model, inside the run's OpenCode settings and never on the sandbox's disk.
 */
export class OpenCodeCloudSignIn implements CloudSignIn {
  constructor(
    private readonly keys: Pick<OpenCodeCloudKeys, "key">,
    private readonly label: (provider: string) => string = providerName,
  ) {}

  private async keyFor(who: CloudRunWho): Promise<{ provider: string; key: string } | null> {
    const provider = providerOf(who.model);
    if (!provider || provider === FREE) return null;
    const key = await this.keys.key(provider);
    if (!key) throw new Error(`OpenCode has no key for ${this.label(provider)} in the cloud. Add one in Settings > Cloud.`);
    return { provider, key };
  }

  async assertCanRun(_provider: CloudProviderId, who: CloudRunWho): Promise<void> {
    await this.keyFor(who);
  }

  async homeEnv(state: string): Promise<Record<string, string>> {
    return { XDG_DATA_HOME: path.posix.join(state, "opencode") };
  }

  /**
   * Brokered, OpenCode holds a stand-in key and the firewall sets the real one on its requests to the provider's API,
   * in the header that provider reads. A provider not in that list keeps its key in the sandbox, as before.
   */
  async prepare(_home: unknown, _provider: CloudProviderId, who: CloudRunWho, brokered: boolean): Promise<TurnSignIn> {
    const found = await this.keyFor(who);
    if (!found) return held({});
    const api = brokered ? PROVIDER_APIS[found.provider] : undefined;
    const apiKey = api ? `sk-${OUTSIDE_THE_SANDBOX}` : found.key;
    const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { [found.provider]: { options: { apiKey } } } }) };
    return { env, headers: api ? [{ domain: api.domain, name: api.header, value: api.scheme ? `${api.scheme} ${found.key}` : found.key }] : [] };
  }

  async keep(): Promise<void> {}
}
