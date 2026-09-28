/** Synthetic RPCs for the real text-generation settings control; no provider calls. */
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  harnessCatalog,
  harnessIds,
  type HarnessId,
  type ModelOption,
  type RpcMethod,
  type RpcParams,
  type RpcResults,
  type TextGenerationSettings as Preferences,
} from "../../packages/protocol/src/index";
import { TextGenerationSettings } from "../../apps/desktop/src/renderer/src/views/settings-text-generation";
import { core } from "../../apps/desktop/src/renderer/src/lib/rpc";
import { queryClient } from "../../apps/desktop/src/renderer/src/lib/query";
import { useTheme, type ThemeChoice } from "../../apps/desktop/src/renderer/src/lib/theme";

let state: { provider: Preferences["provider"]; models: Record<string, string | null> } = JSON.parse(localStorage.getItem("text-preferences") ?? '{"provider":"auto","models":{}}');
let fail = false;
let unavailable = false;
let catalogFailure = false;
let omittedModel: string | null = null;
const defaults: Record<HarnessId, string> = { codex: "gpt-luna", claude: "haiku", opencode: "openrouter/google/gemini-2.5-flash-lite" };
const catalog: ModelOption[] = [
  { agent: "codex", id: "gpt-luna", label: "GPT Luna", provider: { id: "codex", label: "ChatGPT account" } },
  { agent: "codex", id: "gpt-mini", label: "GPT Mini", provider: { id: "codex", label: "ChatGPT account" } },
  { agent: "claude", id: "haiku", label: "Claude Haiku 4.5", provider: { id: "claude", label: "Claude account" } },
  { agent: "opencode", id: "opencode/gpt-mini", label: "GPT Mini", provider: { id: "opencode", label: "OpenCode" } },
  { agent: "opencode", id: "openrouter/openai/gpt-5-mini", label: "GPT Mini", provider: { id: "openrouter", label: "OpenRouter" } },
  { agent: "opencode", id: "openrouter/google/gemini-2.5-flash-lite", label: "Gemini Flash Lite", provider: { id: "openrouter", label: "OpenRouter" } },
  { agent: "opencode", id: "openrouter/acme/blocked", label: "Blocked model", provider: { id: "openrouter", label: "OpenRouter" }, unavailable: "Requires a newer CLI." },
].map((model) => ({ ...model, agent: model.agent as HarnessId, isDefault: false, efforts: ["low", "high"], defaultEffort: "low" }));
const calls: string[] = [];
Object.assign(window, {
  textSmoke: {
    calls,
    theme: (choice: ThemeChoice) => useTheme.getState().set(choice),
    catalogFailure: (value: boolean) => {
      catalogFailure = value;
    },
    omit: (id: string) => {
      omittedModel = id;
    },
    fail: () => {
      fail = true;
    },
    unavailable: () => {
      unavailable = true;
      void queryClient.invalidateQueries();
    },
  },
});
function view(): Preferences {
  const provider = state.provider;
  const chosen = provider === "auto" ? "claude" : provider;
  const model = provider === "auto" || provider === "off" ? null : (state.models[provider] ?? null);
  const resolvedId = chosen === "off" ? null : (model ?? defaults[chosen]);
  return {
    provider,
    model,
    resolved: chosen === "off" || unavailable ? null : { provider: chosen, model: resolvedId!, label: catalog.find((m) => m.agent === chosen && m.id === resolvedId)?.label ?? resolvedId! },
    reason: unavailable && provider !== "off" ? `${harnessCatalog[chosen === "off" ? "codex" : chosen].name} is unavailable. Check its connection in Settings.` : null,
  };
}
core.call = async <M extends RpcMethod>(method: M, input: RpcParams<M>): Promise<RpcResults[M]> => {
  calls.push(method);
  let result: unknown;
  if (method === "textGeneration.settings.get") result = view();
  else if (method === "textGeneration.settings.set") {
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (fail) {
      fail = false;
      throw new Error("Fixture save failure");
    }
    const patch = input as RpcParams<"textGeneration.settings.set">;
    if (patch.provider !== undefined) state.provider = patch.provider;
    if (patch.model !== undefined) state.models[state.provider] = patch.model;
    localStorage.setItem("text-preferences", JSON.stringify(state));
    result = view();
  } else if (method === "agents.models" || method === "agents.modelCatalog" || method === "agents.models.refresh") {
    const agent = (input as RpcParams<"agents.modelCatalog">).agent;
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (catalogFailure) throw new Error("Fixture catalog failure");
    const models = catalog.filter((model) => (!agent || model.agent === agent) && model.id !== omittedModel);
    result = method === "agents.models" ? models : { models, providers: [] };
  } else if (method === "system.info") {
    result = {
      dataDir: "/fixture",
      harnesses: harnessIds.map((id) => ({ id, state: unavailable && id === "opencode" ? "sign_in" : "ready", path: `/bin/${id}`, version: "1", revision: 0 })),
      gh: { installed: false, path: null },
    };
  } else throw new Error(`Unexpected fixture RPC: ${method}`);
  return result as RpcResults[M];
};
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <div className="h-full flex flex-col bg-surface text-ink">
      <header className="h-11 shrink-0 flex items-center px-6 border-b border-line">Settings</header>
      <div className="settings-shell">
        <div className="settings-layout">
          <nav className="settings-nav">
            <div className="settings-tablist">
              <button aria-selected="true">Memory &amp; models</button>
            </div>
          </nav>
          <div className="settings-content">
            <div role="tabpanel">
              <header className="settings-heading">
                <h1 className="text-xl font-semibold">Memory &amp; models</h1>
                <p className="text-md text-ink-2 mt-1">Choose models for thread titles and lessons learned.</p>
              </header>
              <TextGenerationSettings />
            </div>
          </div>
        </div>
      </div>
    </div>
  </QueryClientProvider>,
);
