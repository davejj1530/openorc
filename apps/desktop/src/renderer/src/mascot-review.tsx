import { harnessIds } from "@openorc/protocol";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/query";
import { core } from "./lib/rpc";
import { useTheme } from "./lib/theme";
import { NewThread } from "./views/NewThread";
import { AppearanceSettings } from "./views/settings-appearance";
import "./app.css";
/** Set by the smoke test to act as an account that cannot use Fast. */
let fastBlockedReason: string | null = null;
core.call = (async (method: string) => {
  if (method === "projects.list") return [{ id: "mascot-test", name: "studio", path: "/tmp/mascot-test", defaultBranch: "master" }];
  if (method === "system.info") return { harnesses: harnessIds.map((id) => ({ id, state: "ready", path: id, version: "preview", revision: 0 })) };
  if (method === "review.projectDiff") return { files: [], patch: "" };
  if (method === "app.settings.get") return { defaultWorkspaceMode: "current" };
  if (method === "agents.models" || method === "agents.modelCatalog" || method === "agents.models.refresh") {
    const models = [
      {
        id: "gpt-6-astra",
        agent: "codex",
        label: "GPT-6-Astra",
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultEffort: "medium",
        isDefault: true,
        fastMode: fastBlockedReason ? { supported: false, reason: fastBlockedReason } : { supported: true },
      },
      { id: "gpt-test", agent: "codex", label: "Model with High maximum", efforts: ["low", "high"], defaultEffort: "low", fastMode: { supported: false, reason: "Unavailable for this model." } },
      { id: "fixed-test", agent: "codex", label: "Fixed effort model", efforts: ["high"], defaultEffort: "high", fastMode: { supported: false } },
    ];
    return method === "agents.models" ? models : { models, providers: [] };
  }
  return [];
}) as typeof core.call;
queryClient.setDefaultOptions({ queries: { retry: false } });
function Review() {
  const [mounted, setMounted] = useState(true);
  const [appearance, setAppearance] = useState(false);
  const blockFast = (reason: string) => {
    fastBlockedReason = reason;
    void queryClient.invalidateQueries();
  };
  Object.assign(window, { mascotReview: { theme: useTheme, setMounted, setAppearance, blockFast } });
  return (
    <QueryClientProvider client={queryClient}>
      <main style={{ height: "100%", background: "var(--surface)", overflow: "auto" }}>{appearance ? <AppearanceSettings /> : mounted && <NewThread projectId="mascot-test" />}</main>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Review />
  </StrictMode>,
);
