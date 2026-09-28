/** The production composer, for what it does with a file that is not an image. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Composer } from "../../apps/desktop/src/renderer/src/components/Composer";
import { core } from "../../apps/desktop/src/renderer/src/lib/rpc";
import { useTheme, type ThemeChoice } from "../../apps/desktop/src/renderer/src/lib/theme";

const saved: { name: string; path: string }[] = [];
const sent: { text: string; attachments: string[]; now: boolean }[] = [];
let failNext = false;
let compactCalls = 0;
let stopCalls = 0;
let holdNext = false;
let releaseSend: (() => void) | undefined;
let rejectStop: ((error: Error) => void) | undefined;
let acceptStop: (() => void) | undefined;

core.call = (async (method: string, params: Record<string, unknown>) => {
  if (method === "runs.interrupt") {
    stopCalls++;
    await new Promise<void>((resolve, reject) => {
      acceptStop = resolve;
      rejectStop = reject;
    });
    return null;
  }
  if (method === "attachments.saveFile") {
    const name = params["name"] as string;
    const path = `/data/attachments/00000000-0000-4000-8000-00000000000${saved.length}-${name.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
    saved.push({ name, path });
    return { path, name, bytes: 12 };
  }
  if (method === "attachments.save") {
    const path = `/data/attachments/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee${saved.length}.png`;
    saved.push({ name: params["name"] as string, path });
    return { path, url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" };
  }
  return [];
}) as never;

function App() {
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(true);
  const [nativeStop, setNativeStop] = useState(false);
  const [options, setOptions] = useState({ liveByDefault: true, queueing: true, steerable: true });
  const [context, setContext] = useState<{ used: number; window: number | null }>({ used: 390_000, window: 1_000_000 });
  const [compacting, setCompacting] = useState(false);
  const [canCompact, setCanCompact] = useState(true);
  Object.assign(window, {
    composerSmoke: {
      theme: (choice: ThemeChoice) => useTheme.getState().set(choice),
      options: setOptions,
      failNext: () => {
        failNext = true;
      },
      saved: () => saved,
      sent: () => sent,
      context: setContext,
      compacting: setCompacting,
      canCompact: setCanCompact,
      compactCalls: () => compactCalls,
      stopCalls: () => stopCalls,
      nativeStop: setNativeStop,
      rejectStop: () => rejectStop?.(new Error("Provider refused cancellation")),
      acceptStop: () => acceptStop?.(),
      showComposer: setVisible,
      holdNext: () => {
        holdNext = true;
      },
      releaseSend: () => releaseSend?.(),
    },
  });
  return (
    <div style={{ padding: 24, maxWidth: 900, paddingTop: 320 }}>
      {visible ? (
        <Composer
          draftKey="steering-smoke"
          {...options}
          live={nativeStop ? { runId: "smoke", working: options.queueing } : undefined}
          stopAction={
            nativeStop
              ? undefined
              : {
                  working: options.queueing,
                  pending: false,
                  onStop: () => {
                    stopCalls++;
                  },
                }
          }
          value={value}
          onChange={setValue}
          onSubmit={async (text, attachments, now) => {
            if (failNext) {
              failNext = false;
              throw new Error("Delivery could not be saved. Retry.");
            }
            if (holdNext) {
              holdNext = false;
              await new Promise<void>((resolve) => {
                releaseSend = resolve;
              });
            }
            sent.push({ text, attachments, now });
            setValue("");
          }}
          placeholder="Message the agent…"
          model={{ agent: "codex", model: "gpt-6-astra", effort: "high" }}
          onModel={() => {}}
          mode="act"
          onMode={() => {}}
          permission="trusted"
          onPermission={() => {}}
          location={{ label: "Local checkout", branch: "master" }}
          context={context}
          compacting={compacting}
          compactDisabledReason={canCompact ? undefined : "Available after this turn finishes."}
          onCompact={
            canCompact
              ? () => {
                  compactCalls++;
                  setCompacting(true);
                }
              : undefined
          }
        />
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <App />
  </QueryClientProvider>,
);
