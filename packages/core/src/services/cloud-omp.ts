import path from "node:path";
import type { CloudProviderId } from "@openorc/db";
import { openCodeProvider, openCodeProviderName } from "@openorc/protocol";
import { held, OUTSIDE_THE_SANDBOX, type CloudRunWho, type CloudSignIn, type TurnSignIn } from "./cloud-agents.js";
import { PROVIDER_APIS, type OpenCodeCloudKeys } from "./cloud-opencode.js";

/** The variable Oh My Pi reads each provider's key from, for the providers whose keys the cloud keeps. */
const KEY_VARIABLES: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

/**
 * Oh My Pi in a cloud sandbox: its own folder under the runner's, never anyone's, and for each turn only the API key of
 * the provider serving the thread's model, from the same provider keys the cloud keeps for OpenCode. Sign-ins with an
 * account, such as a ChatGPT or Claude plan, stay on this Mac.
 */
export class OmpCloudSignIn implements CloudSignIn {
  constructor(
    private readonly keys: Pick<OpenCodeCloudKeys, "key">,
    private readonly label: (provider: string) => string = openCodeProviderName,
  ) {}

  private async keyFor(who: CloudRunWho): Promise<{ provider: string; variable: string; key: string }> {
    const provider = openCodeProvider(who.model);
    if (!provider) throw new Error("Choose a model for Oh My Pi to run in the cloud.");
    const variable = KEY_VARIABLES[provider];
    if (!variable)
      throw new Error(
        `Oh My Pi runs in the cloud with a provider API key, which ${this.label(provider)} does not take there. Choose a model from Anthropic, OpenAI, OpenRouter, Google, Groq, Mistral, xAI or DeepSeek.`,
      );
    const key = await this.keys.key(provider);
    if (!key) throw new Error(`Oh My Pi has no key for ${this.label(provider)} in the cloud. Add one in Settings > Cloud.`);
    return { provider, variable, key };
  }

  async assertCanRun(_provider: CloudProviderId, who: CloudRunWho): Promise<void> {
    await this.keyFor(who);
  }

  async homeEnv(state: string): Promise<Record<string, string>> {
    return { PI_CODING_AGENT_DIR: path.posix.join(state, "omp") };
  }

  /** Brokered, Oh My Pi holds a stand-in key and the firewall sets the real one on its requests to the provider's API. */
  async prepare(_home: unknown, _provider: CloudProviderId, who: CloudRunWho, brokered: boolean): Promise<TurnSignIn> {
    const found = await this.keyFor(who);
    const api = brokered ? PROVIDER_APIS[found.provider] : undefined;
    if (!api) return held({ [found.variable]: found.key });
    return {
      env: { [found.variable]: `sk-${OUTSIDE_THE_SANDBOX}` },
      headers: [{ domain: api.domain, name: api.header, value: api.scheme ? `${api.scheme} ${found.key}` : found.key }],
    };
  }

  async keep(): Promise<void> {}
}
