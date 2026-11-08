/** Provider ids whose plain title case reads wrong. */
const providerNames: Record<string, string> = {
  "amazon-bedrock": "Amazon Bedrock",
  "bedrock-mantle": "Bedrock Mantle",
  "github-copilot": "GitHub Copilot",
  "google-antigravity": "Google Antigravity",
  "google-gemini-cli": "Gemini CLI",
  "google-vertex": "Google Vertex",
  "openai-codex": "OpenAI Codex",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  xai: "xAI",
  zai: "Z.AI",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  lmstudio: "LM Studio",
};

export function modelProviderName(id: string): string {
  return providerNames[id] ?? id.replace(/(^|-)([a-z])/g, (_, dash: string, letter: string) => `${dash ? " " : ""}${letter.toUpperCase()}`);
}
