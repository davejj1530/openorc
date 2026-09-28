/** The conversation's tail presence on its own, without the rest of the transcript. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Sparkles } from "../../apps/desktop/src/renderer/src/components/icons";
import { AgentOrb } from "../../apps/desktop/src/renderer/src/components/AgentOrb";
import { useTheme, type ThemeChoice } from "../../apps/desktop/src/renderer/src/lib/theme";

function App() {
  const [working, setWorking] = useState(false);
  Object.assign(window, { orbSmoke: { live: setWorking, theme: (choice: ThemeChoice) => useTheme.getState().set(choice) } });
  return (
    <div className="p-6 grid gap-0">
      {/* A step row above it, the way the transcript stacks them. */}
      <div className="flex items-center gap-2 min-h-6 text-sm text-ink-3">
        <Sparkles size={13} className="tool-icon shrink-0" data-tone="think" />
        <span data-row="sibling">Thought for 2s</span>
      </div>
      <div className="mt-3 flex items-center gap-2 text-sm text-ink-3" role="status">
        <AgentOrb state={working ? "thinking" : "idle"} />
        {working ? <span data-row="working">Working for 8s</span> : null}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
