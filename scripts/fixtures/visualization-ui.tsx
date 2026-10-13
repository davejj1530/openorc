/** Synthetic saved tool calls in the production conversation renderer. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentEvent, Visualization } from "@openorc/protocol";
import { WorkTranscript } from "../../apps/desktop/src/renderer/src/components/Transcript";
import { ThreadMedia } from "../../apps/desktop/src/renderer/src/components/ThreadImages";
import { core } from "../../apps/desktop/src/renderer/src/lib/rpc";
import { applyFrame, getRun, hydrate, resetTranscripts, useTranscripts } from "../../apps/desktop/src/renderer/src/lib/transcript";
import { useTheme } from "../../apps/desktop/src/renderer/src/lib/theme";

const example: Visualization = {
  title: "Binary search",
  description: "Each comparison removes half the remaining possibilities. Step through this sorted list to find 32.",
  html: `<style>
    .search{padding:8px 0}.target{font-size:12px;color:var(--muted);margin:0 0 16px}.target strong{font-size:20px;color:var(--foreground);margin-left:8px}
    .values{list-style:none;display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:8px;padding:0;margin:0 0 20px}
    .values li{display:grid;place-items:center;min-height:52px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font:500 17px/1.2 ui-monospace,monospace;transition:opacity .15s}
    .values li.discarded{opacity:.3}.values li.compared{outline:2px solid var(--accent);outline-offset:2px}.values li.found{border:2px solid var(--accent)}
    #status{min-height:44px;margin:0 0 12px}.controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}#step{font-size:12px;color:var(--muted);margin-left:auto}
    @media(max-width:380px){.values{gap:6px;grid-template-columns:repeat(4,minmax(0,1fr))}}
  </style>
  <div class="search">
    <p class="target">Looking for<strong>32</strong></p>
    <ol class="values" aria-label="Sorted values"></ol>
    <p id="status" aria-live="polite"></p>
    <div class="controls"><button type="button" id="back">Previous</button><button type="button" id="next">Next comparison</button><span id="step"></span></div>
  </div>
  <script>
    const values=[2,5,8,11,14,17,20,23,26,29,32,35,38,41,44,47];
    const states=[
      {lo:0,hi:15,mid:-1,text:'Start with all 16 values. Compare the target with the middle value.'},
      {lo:8,hi:15,mid:7,text:'23 is less than 32. Discard 23 and everything to its left.'},
      {lo:8,hi:10,mid:11,text:'35 is greater than 32. Discard 35 and everything to its right.'},
      {lo:10,hi:10,mid:9,text:'29 is less than 32. Only one possibility remains.'},
      {lo:10,hi:10,mid:10,text:'Found 32 in four comparisons. A linear search would take eleven.'}
    ];
    let step=0;
    const render=()=>{
      const s=states[step];
      const list=document.querySelector('.values');list.replaceChildren();
      values.forEach((value,index)=>{const li=document.createElement('li');li.textContent=value;
        li.className=index===s.mid?(step===4?'found':'compared'):index<s.lo||index>s.hi?'discarded':'';
        li.setAttribute('aria-label',value+(index===s.mid?(step===4?', found':', compared'):index<s.lo||index>s.hi?', discarded':', candidate'));list.append(li);});
      document.getElementById('status').textContent=s.text;
      document.getElementById('step').textContent=step+' / 4 comparisons';
      document.getElementById('back').disabled=step===0;document.getElementById('next').disabled=step===4;
    };
    document.getElementById('next').onclick=()=>{step++;render()};document.getElementById('back').onclick=()=>{step--;render()};render();
  </script>`,
};
const runId = "visualization-fixture";
const server = `openorc_${"a".repeat(32)}`;
const names = { Codex: `${server}.visualize`, "Claude Code": `mcp__${server}__visualize`, OpenCode: `${server}_visualize`, "Broken example": `${server}.visualize` };
let ledger: AgentEvent[] = [];
function show(name: string, broken = false) {
  const input = broken ? { ...example, html: "<p>A saved explanation remains readable.</p><script>throw Error('Example script failed')</script>" } : example;
  ledger = [
    { type: "message.completed", runId, ts: 1, messageId: "ask", role: "user", text: "Help me understand binary search visually." },
    { type: "tool.started", runId, ts: 2, toolCallId: "visual", name, input, parentToolCallId: null },
    {
      type: "tool.completed",
      runId,
      ts: 3,
      toolCallId: "visual",
      name,
      mcp: { server, tool: "visualize" },
      output: { content: [{ type: "text", text: "Visualization added to the conversation." }] },
      isError: false,
    },
    {
      type: "message.completed",
      runId,
      ts: 4,
      messageId: "answer",
      role: "assistant",
      text: "Binary search works because the list is sorted. Every comparison tells you which half can contain the answer.",
    },
    { type: "turn.completed", runId, ts: 5, turnId: "turn", status: "success", durationMs: 4 },
    { type: "session.completed", runId, ts: 6, status: "success", durationMs: 5 },
  ];
  resetTranscripts();
  applyFrame({ runId, seq: 1, events: ledger });
}
Object.assign(core, {
  call: async (method: string) => {
    if (method === "events.page") return { events: JSON.parse(JSON.stringify(ledger)), fromTurn: 0, live: false };
    throw new Error(`No live provider: ${method}`);
  },
});
show(names.Codex);

function App() {
  useTranscripts((s) => s.runs);
  const [generation, setGeneration] = useState(0);
  const [activity, setActivity] = useState(true);
  const theme = useTheme((s) => s.resolved);
  return (
    <main className="h-full overflow-auto bg-surface text-ink">
      <div style={{ maxWidth: 784, margin: "auto", padding: "24px 20px" }}>
        <h1 className="text-lg font-semibold">Visual explanations</h1>
        <p className="my-2 text-sm text-ink-3">A saved conversation with an interactive concept.</p>
        <div className="my-5 flex flex-wrap gap-3 text-xs text-ink-2">
          {Object.entries(names).map(([label, name]) => (
            <button
              key={label}
              onClick={() => {
                show(name, label === "Broken example");
                setGeneration((n) => n + 1);
              }}
            >
              {label}
            </button>
          ))}
          <button onClick={() => useTheme.getState().set(theme === "light" ? "dark" : "light")}>Switch theme</button>
          <button onClick={() => setActivity((value) => !value)}>Toggle activity</button>
          <button
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
          <WorkTranscript runId={runId} blocks={getRun(runId)?.blocks ?? []} showActivity={activity} />
        </ThreadMedia>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
