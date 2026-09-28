import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThreadRichText } from "../../apps/desktop/src/renderer/src/components/ThreadImages";
import { RichText } from "../../apps/desktop/src/renderer/src/components/RichText";
import { BrowserPanel } from "../../apps/desktop/src/renderer/src/panels/BrowserPanel";
import { useBrowserPreview } from "../../apps/desktop/src/renderer/src/lib/browser-preview";

function Preview() {
  const [open, setOpen] = useState(false);
  const reveal = useCallback(() => setOpen(true), []);
  useBrowserPreview("thread:links", reveal);
  return open ? (
    <aside style={{ width: 420, flexShrink: 0 }} className="border-l border-line">
      <BrowserPanel id="thread:links" defaultUrl="http://localhost:3000" />
    </aside>
  ) : null;
}

function Fixture() {
  return (
    <div style={{ display: "flex", height: "100vh" }} className="bg-surface text-ink">
      <main style={{ flex: 1, minWidth: 0, padding: 32 }} className="prose-chat">
        <h1 className="text-lg font-semibold mb-6">Thread links</h1>
        <ThreadRichText mode="static">{`Here is the [first page](${location.origin}/page-a).\n\nRead the [second page](${location.origin}/page-b).`}</ThreadRichText>
        <RichText mode="static">{`A [document link](${location.origin}/page-c) uses the shared renderer.`}</RichText>
      </main>
      {window.openorc?.browser ? <Preview /> : null}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
