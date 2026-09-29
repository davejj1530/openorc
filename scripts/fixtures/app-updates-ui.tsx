/** Synthetic release states driving the production notice. No downloads or installs. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { UpdateSnapshot, UpdateState } from "../../apps/desktop/src/shared/app-updates";
import type { OpenOrcApi } from "../../apps/desktop/src/shared/types";
import { AppUpdateNoticeContent } from "../../apps/desktop/src/renderer/src/components/AppUpdateNotice";
import { useTheme } from "../../apps/desktop/src/renderer/src/lib/theme";

const params = new URLSearchParams(location.search);
useTheme.getState().set(params.get("theme") === "dark" ? "dark" : "light");
if (params.has("custom")) useTheme.getState().setColor("--surface-2", "#e5edf0");
const version = "0.2.0";
function Preview() {
  const [snapshot, setSnapshot] = useState<UpdateSnapshot>({ state: { phase: "available", version }, dismissed: false });
  const push = (state: UpdateState) => setSnapshot({ state, dismissed: false });
  window.openorc = {
    updates: {
      download: async () => {
        for (const percent of [0, 25, 50, 75, 100]) {
          push({ phase: "downloading", version, percent });
          await new Promise((resolve) => setTimeout(resolve, 600));
        }
        push({ phase: "ready", version });
      },
      install: async () => push({ phase: "ready", version, error: "Close your running terminal panels before restarting to update." }),
      dismiss: async () => setSnapshot((current) => ({ ...current, dismissed: true })),
    },
  } as unknown as OpenOrcApi;
  return (
    <div className="h-full bg-surface text-ink overflow-auto">
      <header className="p-4 border-b border-line text-sm text-ink-2">OpenOrc · Synthetic app update preview</header>
      <nav className="p-4 flex flex-wrap gap-4 text-sm" aria-label="Preview states">
        <button onClick={() => push({ phase: "available", version })}>Available</button>
        <button onClick={() => push({ phase: "downloading", version, percent: 47 })}>Progress</button>
        <button onClick={() => push({ phase: "ready", version })}>Ready</button>
        <button onClick={() => push({ phase: "available", version, error: "Network disconnected. Check your connection and try again." })}>Download failure</button>
        <button onClick={() => push({ phase: "install-error", message: "Core shutdown could not be confirmed." })}>Install failure</button>
        <a href="?theme=dark">Dark</a>
        <a href="?theme=light&narrow">Narrow light</a>
        <a href="?theme=light&custom">Custom colors</a>
      </nav>
      <div style={{ position: "relative", margin: "0 auto", width: params.has("narrow") ? "min(360px, 100%)" : "100%", height: 550 }}>
        <div className="workspace-update-notices" style={{ position: "absolute", top: 4, width: "min(422px, calc(100% - 8px))" }}>
          <AppUpdateNoticeContent snapshot={snapshot} />
          <aside className="agent-update-notice" aria-label="Agent updates">
            <div>
              <p className="font-medium">Agent updates available</p>
              <p className="mt-1 text-sm text-ink-2">Shown together to verify notices do not overlap.</p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
