/** The production MCP Apps component and transcript, with an isolated test backend. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentEvent } from "@openorc/protocol";
import { TranscriptContents } from "../../apps/desktop/src/renderer/src/components/Transcript";
import { ThreadMedia } from "../../apps/desktop/src/renderer/src/components/ThreadImages";
import { core } from "../../apps/desktop/src/renderer/src/lib/rpc";
import { applyFrame, getRun, resetTranscripts, useTranscripts } from "../../apps/desktop/src/renderer/src/lib/transcript";
import { useTheme } from "../../apps/desktop/src/renderer/src/lib/theme";

declare global {
  interface Window {
    mcpFixture: { call(method: string, params: unknown): Promise<unknown> };
  }
}
Object.assign(core, { call: (method: string, params: unknown) => window.mcpFixture.call(method, params) });
function show(tool: string) {
  const ev: AgentEvent = {
    type: "tool.completed",
    runId: "fixture",
    ts: 1,
    toolCallId: tool,
    name: `${tool}.show`,
    mcp: { server: tool, tool: "show" },
    input: { query: "Appearance" },
    output: { content: [{ type: "text", text: "The original result stays available." }] },
    isError: false,
  };
  resetTranscripts();
  applyFrame({ runId: "fixture", seq: 1, events: [ev] });
}
show("gallery");
function App() {
  useTranscripts((s) => s.runs);
  const [choice, setChoice] = useState("gallery");
  const theme = useTheme((s) => s.resolved);
  return (
    <main style={{ maxWidth: 920, padding: 24, margin: "auto" }}>
      <h1 className="text-xl font-semibold">Interactive MCP Apps</h1>
      <p className="text-sm text-ink-3 my-2">One host, server-provided interfaces.</p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "24px 0" }}>
        {["gallery", "weather", "mobbin", "unsupported", "missing"].map((name) => (
          <button
            key={name}
            className="rounded-md bg-surface-2 px-3 py-2 text-sm"
            onClick={() => {
              setChoice(name);
              show(name);
            }}
          >
            {name}
          </button>
        ))}
        <button className="rounded-md bg-surface-2 px-3 py-2 text-sm" onClick={() => useTheme.getState().set(theme === "light" ? "dark" : "light")}>
          Switch theme
        </button>
      </div>
      <ThreadMedia scopeKey={choice}>
        <TranscriptContents key={choice} runId="fixture" blocks={getRun("fixture")?.blocks ?? []} groupTools={false} />
      </ThreadMedia>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
