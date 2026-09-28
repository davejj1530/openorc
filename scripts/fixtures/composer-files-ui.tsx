/** The production composer, for what it does with a file that is not an image. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Composer } from "../../apps/desktop/src/renderer/src/components/Composer";
import { core } from "../../apps/desktop/src/renderer/src/lib/rpc";
import { useTheme, type ThemeChoice } from "../../apps/desktop/src/renderer/src/lib/theme";

const saved: { name: string; path: string }[] = [];
const sent: { text: string; attachments: string[] }[] = [];

core.call = (async (method: string, params: Record<string, unknown>) => {
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
  Object.assign(window, {
    composerSmoke: {
      theme: (choice: ThemeChoice) => useTheme.getState().set(choice),
      saved: () => saved,
      sent: () => sent,
    },
  });
  return (
    <div style={{ padding: 24, maxWidth: 760 }}>
      <Composer
        value={value}
        onChange={setValue}
        onSubmit={async (text, attachments) => {
          sent.push({ text, attachments });
        }}
        placeholder="Message the agent…"
        model={null}
        onModel={() => {}}
        mode="act"
        onMode={() => {}}
        permission="trusted"
        onPermission={() => {}}
        location={{ label: null, branch: null }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <App />
  </QueryClientProvider>,
);
