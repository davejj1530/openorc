import { useEffect, useId, useRef, useState } from "react";
import { VisualizationFrameMessage, type Visualization } from "@openorc/protocol";
import { visualizationContext, visualizationDocument } from "../lib/visualization-document";
import { TextButton } from "./ui";

export default function VisualizationResult({ visualization }: { visualization: Visualization }) {
  const [visible, setVisible] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const descriptionId = useId();
  return (
    <section aria-label={visualization.title} aria-describedby={descriptionId} className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-md text-ink">{visualization.title}</h3>
        <div className="flex shrink-0 gap-3 text-xs text-ink-4">
          {visible ? <TextButton onClick={() => setAttempt((n) => n + 1)}>Reset</TextButton> : null}
          <TextButton aria-expanded={visible} onClick={() => setVisible((value) => !value)}>
            {visible ? "Hide visualization" : "Show visualization"}
          </TextButton>
        </div>
      </div>
      <p id={descriptionId} className="my-2 whitespace-pre-wrap text-sm text-ink-2">
        {visualization.description}
      </p>
      {visible ? <VisualizationFrame key={attempt} title={visualization.title} html={visualization.html} /> : null}
    </section>
  );
}

type FrameState = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

function VisualizationFrame({ title, html }: { title: string; html: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(320);
  const [state, setState] = useState<FrameState>({ kind: "loading" });
  useEffect(() => {
    const iframe = frame.current;
    if (!iframe) return;
    let disposed = false;
    let registration: { id: string; url: string } | undefined;
    setState({ kind: "loading" });
    const timeout = window.setTimeout(() => setState({ kind: "error", message: "This visualization did not finish loading. Try Reset." }), 15_000);
    const send = (method: string, params: unknown) => {
      if (registration) iframe.contentWindow?.postMessage({ jsonrpc: "2.0", method, params }, new URL(registration.url).origin);
    };
    const context = () => send("openorc/visualization-context", visualizationContext());
    const receive = (event: MessageEvent<unknown>) => {
      if (!registration || event.source !== iframe.contentWindow || event.origin !== new URL(registration.url).origin) return;
      const result = VisualizationFrameMessage.safeParse(event.data);
      if (!result.success) return;
      const message = result.data;
      switch (message.method) {
        case "ui/notifications/sandbox-proxy-ready":
          send("ui/notifications/sandbox-resource-ready", {});
          break;
        case "ui/notifications/initialized":
          window.clearTimeout(timeout);
          context();
          setState({ kind: "ready" });
          break;
        case "ui/notifications/size-changed":
          setHeight(Math.min(1200, Math.max(120, message.params.height)));
          break;
        case "openorc/visualization-error":
          window.clearTimeout(timeout);
          setState({ kind: "error", message: message.params.message });
          break;
      }
    };
    window.addEventListener("message", receive);
    const observer = new MutationObserver(context);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette", "style"] });
    void (async () => {
      registration = await window.openorc.mcpApps.register({ html: visualizationDocument(html), csp: {} });
      if (disposed) {
        window.openorc.mcpApps.release(registration.id);
        return;
      }
      iframe.src = registration.url;
    })().catch((error: unknown) => {
      if (disposed) return;
      window.clearTimeout(timeout);
      setState({ kind: "error", message: error instanceof Error ? error.message : "This visualization could not open." });
    });
    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("message", receive);
      window.clearTimeout(timeout);
      if (registration) window.openorc.mcpApps.release(registration.id);
    };
  }, [html]);
  return (
    <>
      {state.kind !== "ready" ? (
        <p role="status" className="my-2 text-xs text-ink-3">
          {state.kind === "loading" ? "Loading visualization…" : `Visualization unavailable: ${state.message}`}
        </p>
      ) : null}
      <iframe
        ref={frame}
        title={title}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        style={{ width: "100%", height, border: 0, display: state.kind === "error" ? "none" : "block", visibility: state.kind === "loading" ? "hidden" : "visible" }}
      />
    </>
  );
}
