/** Synthetic tool results in the production transcript; no provider calls or user data. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentEvent } from "@openorc/protocol";
import { ThreadMedia } from "../../apps/desktop/src/renderer/src/components/ThreadImages";
import { TranscriptContents } from "../../apps/desktop/src/renderer/src/components/Transcript";
import { applyFrame, getRun, hydrate, resetTranscripts, useTranscripts } from "../../apps/desktop/src/renderer/src/lib/transcript";
import { core } from "../../apps/desktop/src/renderer/src/lib/rpc";
import { useTheme } from "../../apps/desktop/src/renderer/src/lib/theme";

function sample(width: number, height: number, title: string, dark = false) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = dark ? "#18191b" : "#f6f5f2";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = dark ? "#303236" : "#e4e2dc";
  ctx.fillRect(0, 0, width, 48);
  ctx.fillStyle = dark ? "#ededed" : "#292927";
  ctx.font = "600 22px system-ui";
  ctx.fillText(title, 28, 96);
  ctx.font = "14px system-ui";
  ctx.fillText("Choose your appearance", 28, 126);
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = dark ? "#303236" : "#e4e2dc";
    ctx.fillRect(28, 158 + i * 76, width - 56, 56);
    ctx.fillStyle = ["#5079ad", "#588571", "#c9a77a"][i]!;
    ctx.fillRect(40, 170 + i * 76, 32, 32);
    ctx.fillStyle = dark ? "#ededed" : "#292927";
    ctx.fillText(["Ocean", "Forest", "Sand"][i]!, 86, 193 + i * 76);
  }
  return canvas.toDataURL("image/png").split(",")[1]!;
}
const images = [sample(760, 440, "Workspace"), sample(360, 650, "Preferences", true), sample(620, 480, "Personalize")];
const imageBlocks = images.map((data) => ({ type: "image", mimeType: "image/png", data }));
const metadata = { screens: images.map((_, index) => ({ index, app_name: `Sample ${index + 1}`, image_url: `https://example.com/screens/${index + 1}` })) };
const samples: Record<string, unknown> = {
  Codex: { content: [{ type: "text", text: JSON.stringify(metadata) }, ...imageBlocks], structuredContent: metadata },
  Claude: [{ type: "text", text: "Three appearance references." }, ...images.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } }))],
  "Image only": { content: [imageBlocks[0]] },
  Resources: {
    content: [
      { type: "resource", resource: { uri: "resource://reference", mimeType: "image/png", blob: images[1] } },
      { type: "resource", resource: { uri: "resource://notes", mimeType: "text/plain", text: "A text resource stays readable alongside the image." } },
      { type: "resource_link", uri: "https://example.com/reference", name: "Open reference" },
    ],
  },
  "Plain output": "Command finished successfully.\n2 tests passed.\n<script>This stays literal.</script>",
  Unsupported: { content: [null, { type: "future", value: 42 }, { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" }] },
  "Broken image": { content: [{ type: "image", mimeType: "image/png", data: "aW52YWxpZA==" }] },
};
let ledger: AgentEvent[] = [];
const runId = "rich-result-review";
function selectSample(name: string) {
  ledger = [
    { type: "tool.started", runId, ts: 1000, toolCallId: "search", name: "reference.search_screens", input: { query: "Appearance preferences", limit: 3 }, parentToolCallId: null },
    { type: "tool.completed", runId, ts: 2000, toolCallId: "search", name: "reference.search_screens", output: samples[name], isError: false },
  ];
  resetTranscripts();
  applyFrame({ runId, seq: 1, events: ledger });
}
Object.assign(core, { call: async (method: string) => (method === "events.page" ? { events: JSON.parse(JSON.stringify(ledger)), fromTurn: 0, live: false } : null) });
selectSample("Codex");
function App() {
  useTranscripts((s) => s.runs);
  const [selected, setSelected] = useState("Codex");
  const [generation, setGeneration] = useState(0);
  const theme = useTheme((s) => s.resolved);
  return (
    <main className="h-full overflow-auto bg-surface text-ink">
      <div style={{ maxWidth: 896, margin: "0 auto", padding: "32px 20px" }}>
        <h1 className="text-xl font-semibold">Tool result previews</h1>
        <p className="mt-2 text-sm text-ink-3">Synthetic responses rendered by OpenOrc’s transcript.</p>
        <div className="my-5 flex flex-wrap gap-2">
          {Object.keys(samples).map((name) => (
            <button
              key={name}
              className="rounded-md bg-surface-2 px-3 py-2 text-sm"
              aria-pressed={selected === name}
              onClick={() => {
                setSelected(name);
                selectSample(name);
              }}
            >
              {name}
            </button>
          ))}
          <button className="rounded-md bg-surface-2 px-3 py-2 text-sm" onClick={() => useTheme.getState().set(theme === "light" ? "dark" : "light")}>
            Switch theme
          </button>
          <button
            className="rounded-md bg-surface-2 px-3 py-2 text-sm"
            onClick={async () => {
              resetTranscripts();
              await hydrate(runId);
              setGeneration((n) => n + 1);
            }}
          >
            Reload history
          </button>
        </div>
        <ThreadMedia key={generation} scopeKey={runId}>
          <TranscriptContents runId={runId} blocks={[...(getRun(runId)?.blocks ?? [])]} groupTools={false} />
        </ThreadMedia>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
