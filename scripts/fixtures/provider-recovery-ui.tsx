/** Synthetic account recovery and model catalog. Never connects to a real provider. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ModelCatalog, ProviderUsage, RpcMethod, RpcParams, RpcResults } from "../../packages/protocol/src/index";
import { harnessIds } from "../../packages/protocol/src/index";
import { ProviderUsageOverview } from "../../apps/desktop/src/renderer/src/views/settings-usage";
import { ModelPicker, type ModelChoice } from "../../apps/desktop/src/renderer/src/components/ModelPicker";
import { WorkTranscript } from "../../apps/desktop/src/renderer/src/components/Transcript";
import { core } from "../../apps/desktop/src/renderer/src/lib/rpc";
import { queryClient } from "../../apps/desktop/src/renderer/src/lib/query";
import { useTheme } from "../../apps/desktop/src/renderer/src/lib/theme";

const now = Date.now();
let outcome: "reset" | "pending" | "confirmationRequired" = "reset";
let used = false;
const catalog: ModelCatalog = {
  models: [
    { id: "gpt-new-fixture", label: "GPT New", agent: "codex", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "claude-sonnet-9", label: "Sonnet 9", agent: "claude", isDefault: true, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
  ],
  providers: [{ agent: "claude", status: "stale", refreshedAt: now, message: "Could not refresh models. Showing the last loaded list. Check the CLI connection and try Refresh models." }],
};
function report(provider: ProviderUsage["provider"]): ProviderUsage {
  return {
    provider,
    status: "available",
    source: "Synthetic provider report",
    context: provider === "codex" ? "ChatGPT · Pro · fixture@example.test" : "Claude Code login",
    checkedAt: now,
    refreshedAt: now,
    message: null,
    credits: [],
    localRuns: 42,
    accountUrl: "https://example.test/fixture-usage",
    windows:
      provider === "opencode"
        ? []
        : [
            {
              id: "weekly",
              label: "7-day window",
              usedPercent: used && provider === "codex" ? 0 : 100,
              remainingPercent: used && provider === "codex" ? 100 : 0,
              exhausted: !used,
              observedAt: now,
              resetsAt: now + 86400000,
            },
          ],
    resets: resetInventory(provider),
  };
}
core.call = async <M extends RpcMethod>(method: M, input: RpcParams<M>): Promise<RpcResults[M]> => {
  let result: unknown;
  if (method === "memory.settings.get") result = {};
  else if (method === "providers.usage") result = report((input as RpcParams<"providers.usage">).provider);
  else if (method === "providers.codex.reset") {
    if (outcome === "reset") used = true;
    result = {
      outcome,
      message: resetMessage(outcome),
      usage: report("codex"),
    };
  } else if (method === "agents.modelCatalog" || method === "agents.models.refresh") result = catalog;
  else if (method === "agents.models") result = catalog.models;
  else if (method === "system.info")
    result = { dataDir: "/fixture", harnesses: harnessIds.map((id) => ({ id, state: "ready", path: "/fixture", version: "fixture", revision: 1 })), gh: { installed: false, path: null } };
  else throw new Error(`Unexpected fixture RPC: ${method}`);
  return result as RpcResults[M];
};
Object.assign(window, {
  openorc: {
    openExternal: () => {
      window.dispatchEvent(new Event("focus"));
    },
  },
});
Object.assign(window, {
  recoveryFixture: {
    theme: (theme: "light" | "dark") => useTheme.getState().set(theme),
    outcome: (next: typeof outcome) => {
      outcome = next;
    },
  },
});
function App() {
  const [choice, setChoice] = useState<ModelChoice>({ agent: "codex", model: "saved-model-fixture", effort: "high" });
  return (
    <QueryClientProvider client={queryClient}>
      <div className="h-full flex flex-col bg-surface text-ink">
        <header className="h-11 shrink-0 flex items-center gap-4 px-6 border-b border-line">
          <span>Recovery verification · simulated accounts</span>
          <button onClick={() => useTheme.getState().set("light")}>Light</button>
          <button onClick={() => useTheme.getState().set("dark")}>Dark</button>
        </header>
        <div className="settings-shell">
          <div className="settings-layout">
            <div className="settings-content">
              <header className="settings-heading">
                <h1>Usage & allowances</h1>
                <p>Your providers, their limits, and what’s left.</p>
              </header>
              <div className="mb-4">
                <ModelPicker value={choice} onChange={setChoice} />
              </div>
              <WorkTranscript
                runId="fixture"
                blocks={[
                  { id: "quota", kind: "activity", label: "Rate limit reached", status: "error", text: "Your usage limit was reached.", recovery: { kind: "usage", provider: "codex" } },
                  { id: "end", kind: "status", text: "Failed", tone: "bad", boundary: "turn", outcome: "error" },
                ]}
              />
              <ProviderUsageOverview active />
            </div>
          </div>
        </div>
      </div>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

function resetInventory(provider: string): ProviderUsage["resets"] {
  if (provider === "codex")
    return {
      availableCount: used ? 1 : 2,
      credits: [{ id: "fixture", title: "Full reset", description: "Refresh eligible Codex usage windows.", expiresAt: now + 86400000 * 5 }],
      redemption: "available",
      confirmationToken: "fixture-snapshot",
    };
  if (provider === "claude")
    return {
      availableCount: null,
      credits: null,
      redemption: "external",
      message: "If you have a free reset, use it in Claude Settings → Usage on the web or in Claude Desktop. Return here to refresh your allowance.",
    };
  return undefined;
}
function resetMessage(result: string): string {
  if (result === "reset") return "Reset used. Check the refreshed allowance below before continuing.";
  if (result === "pending") return "The reset outcome could not be confirmed. Retry this same attempt to check safely.";
  return "The account or reset inventory changed. Review the refreshed details and confirm again.";
}
