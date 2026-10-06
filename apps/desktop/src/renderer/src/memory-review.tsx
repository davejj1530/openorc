/** Disposable preview of the production memory surfaces; never connects to the core. */
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import type { Memory as MemoryEntry, MemorySettings as Settings } from "@openorc/protocol";
import { Memory } from "./views/Memory";
import { MemorySettings } from "./views/Settings";
import { queryClient } from "./lib/query";
import { core } from "./lib/rpc";
import { useTheme } from "./lib/theme";
import { useLayout } from "./lib/layout";
import "./lib/app-font";
import "./app.css";
const params = new URLSearchParams(location.search);
useTheme.getState().setPreset("openorc");
useTheme.getState().set(params.get("theme") === "light" ? "light" : "dark");
useLayout.setState({ sidebarOpen: true, projectId: "fixture" });
queryClient.setDefaultOptions({ queries: { retry: false } });
let policy: Settings = { enabled: params.get("state") === "on", provider: "off", model: null, hasApiKey: false, resolved: null, automatic: [], reason: null };
let failSave = params.get("state") === "save-error";
let failLoad = params.get("state") === "load-error";
const now = Date.now();
let entries: MemoryEntry[] = [
  {
    title: "Keep agent work in its originating conversation",
    body: "A task records work within a conversation. Starting it keeps the implementation and workspace in that conversation.",
    type: "decision",
    source: "agent",
    topicKey: "tasks/conversations",
  },
  {
    title: "Run the focused test suite first",
    body: "Use pnpm exec vitest run with the relevant test file before running the full suite. This makes a failure easier to locate.",
    type: "command",
    source: "extraction",
    topicKey: "testing/focused-checks",
  },
  {
    title: "Keep native memory settings independent",
    body: "OpenOrc memory is shared across agents. Each harness also controls its own local memory separately.",
    type: "lesson",
    source: "user",
    topicKey: null,
  },
].map((entry, index) => ({
  ...entry,
  id: String(index),
  projectId: "fixture",
  scope: "project",
  status: "active",
  confidence: 0.8,
  sourceRunId: null,
  sourceTaskId: null,
  evidenceCount: index === 0 ? 2 : 1,
  files: [],
  createdAt: now - 86400000 * (index + 2),
  updatedAt: now - 86400000 * (index + 1),
  lastConfirmedAt: now - 86400000 * (index + 1),
})) as MemoryEntry[];
if (params.get("state") === "empty") entries = [];
if (params.get("state") === "paginated")
  entries = Array.from({ length: 56 }, (_, index) => ({
    ...entries[index % entries.length]!,
    id: String(index),
    title: `${entries[index % entries.length]!.title} (${index + 1})`,
  }));
function reviewMemories(method: string, input: Record<string, unknown>) {
  if (input.projectId === "other") return [];
  const matching = entries.filter((m) => {
    if (Array.isArray(input.types) && !input.types.includes(m.type)) return false;
    if (Array.isArray(input.sources) && !input.sources.includes(m.source)) return false;
    return !input.query || `${m.title} ${m.body}`.toLowerCase().includes(String(input.query).toLowerCase());
  });
  if (method === "memory.search") return matching.slice(0, Number(input.limit ?? 50));
  const offset = Number(input.offset ?? 0);
  return matching.slice(offset, offset + Number(input.limit ?? 200));
}
core.call = (async (method: string, input: Record<string, unknown>) => {
  if (method === "projects.list")
    return [
      { id: "fixture", name: "studio" },
      { id: "other", name: "Another project" },
    ];
  if (method === "memory.settings.get") return { ...policy };
  if (method === "memory.settings.set") {
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (failSave) {
      failSave = false;
      throw Error("Fixture save failure");
    }
    policy = { ...policy, ...input };
    return { ...policy };
  }
  if (method === "memory.list" || method === "memory.search") {
    if (failLoad) {
      failLoad = false;
      throw Error("Fixture load failure");
    }
    if (params.get("state") === "loading") await new Promise((resolve) => setTimeout(resolve, 15000));
    return reviewMemories(method, input);
  }
  if (method === "memory.update") {
    entries = entries.map((m) => (m.id === input.id ? { ...m, ...(input.patch as object), updatedAt: Date.now() } : m));
    return entries.find((m) => m.id === input.id);
  }
  if (method === "memory.remove") {
    entries = entries.filter((m) => m.id !== input.id);
    return null;
  }
  if (method === "memory.feedback") {
    entries = entries.map((m) => (m.id === input.id ? { ...m, status: input.verdict === "wrong" ? "retracted" : m.status, lastConfirmedAt: Date.now() } : m));
    return entries.find((m) => m.id === input.id);
  }
  if (method === "agents.models") return [];
  throw Error(`Unsupported fixture RPC: ${method}`);
}) as typeof core.call;
const width = Number(params.get("width")) || 1100;
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <div style={{ width: `min(100%, ${width}px)`, height: "100vh", marginInline: "auto", display: "flex", flexDirection: "column", background: "var(--surface)", overflow: "hidden" }}>
      {params.get("view") === "settings" ? (
        <div className="memory-page">
          <div className="memory-content">
            <h1 className="text-xl font-semibold mb-6">Memory settings</h1>
            <MemorySettings />
          </div>
        </div>
      ) : (
        <Memory />
      )}
    </div>
  </QueryClientProvider>,
);
