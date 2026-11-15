/** The provider a model id `provider/model` names, as OpenCode writes it; null for an id without one. */
export const openCodeProvider = (model: string | null | undefined): string | null => (model?.includes("/") ? model.slice(0, model.indexOf("/")) : null);

/** How the providers people most often add are written; any other reads as OpenCode names it. */
const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  google: "Google",
  groq: "Groq",
  mistral: "Mistral",
  xai: "xAI",
  deepseek: "DeepSeek",
  opencode: "OpenCode Zen",
};
export const openCodeProviderName = (provider: string): string => PROVIDER_NAMES[provider] ?? provider;
