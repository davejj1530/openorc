import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Transcript } from "../../apps/desktop/src/renderer/src/components/Transcript";
import { applyFrame, getRun } from "../../apps/desktop/src/renderer/src/lib/transcript";

applyFrame({ runId: "scroll", seq: 1, events: [{ type: "session.started", runId: "scroll", ts: 1, agent: "codex", externalSessionId: "scroll", model: "fixture" }] });
function App() {
  const [revision, update] = useState(0);
  const [runId, setRunId] = useState("scroll");
  const [scrollKey, setScrollKey] = useState("thread");
  const [sends, setSends] = useState(0);
  Object.assign(window, {
    scrollSmoke: {
      update: () => flushSync(() => update((n) => n + 1)),
      nextRun: () => flushSync(() => setRunId("next-run")),
      nextThread: () => flushSync(() => setScrollKey("next-thread")),
      send: () => flushSync(() => setSends((n) => n + 1)),
    },
  });
  const run = getRun("scroll")!;
  return (
    <Transcript
      followKey={sends}
      scrollKey={scrollKey}
      run={{
        ...run,
        runId,
        blocks: Array.from({ length: 60 }, (_, i) => ({
          id: `message-${i}`,
          kind: "message" as const,
          role: "user" as const,
          text: `Message ${i}\n` + "A line of conversation\n".repeat(8) + (i === 59 ? `Update ${revision}\n`.repeat(revision + 1) : ""),
          streaming: false,
        })),
      }}
    />
  );
}
createRoot(document.getElementById("root")!).render(<App />);
