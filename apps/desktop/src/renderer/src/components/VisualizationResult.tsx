import { useEffect, useId, useRef, useState } from "react";
import { visualizationDocument, visualizationFrameHeight } from "@openorc/client";
import { VisualizationFrameMessage, type Visualization } from "@openorc/protocol";
import { visualizationContext } from "../lib/visualization-context";
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

const TIMED_OUT = "This visualization did not finish loading. Try Reset.";
const STOPPED = "This visualization stopped. Try Reset.";

function FrameStatus({ text }: { text: string }) {
  return (
    <p role="status" className="my-2 text-xs text-ink-3">
      {text}
    </p>
  );
}

/**
 * A visualization's page, or once it fails, only its quiet line. The frame goes with the failure, and with it the
 * page's renderer, which Chromium ends once no frame is left in it, even one a page holds in a loop. Reset makes a new
 * one.
 */
function VisualizationFrame({ title, html }: { title: string; html: string }) {
  const [failure, setFailure] = useState<string>();
  return failure === undefined ? <FramePage title={title} html={html} onFail={setFailure} /> : <FrameStatus text={`Visualization unavailable: ${failure}`} />;
}

/**
 * Calls back when the page's end of the channel it handed over as it came up closes, which happens when its renderer
 * ends: a page that crashes after it was up says nothing, and its frame would stay a gray box.
 */
function watchLifeline(port: MessagePort, ended: () => void): () => void {
  port.addEventListener("close", ended);
  port.start();
  return () => {
    port.removeEventListener("close", ended);
    port.close();
  };
}

function FramePage({ title, html, onFail }: { title: string; html: string; onFail: (message: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(320);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const iframe = frame.current;
    if (!iframe) return;
    let disposed = false;
    let registration: { id: string; url: string } | undefined;
    let unwatch: (() => void) | undefined;
    const fail = (message: string) => {
      if (!disposed) onFail(message);
    };
    const timeout = window.setTimeout(() => fail(TIMED_OUT), 15_000);
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
          if (!unwatch && event.ports[0]) unwatch = watchLifeline(event.ports[0], () => fail(STOPPED));
          context();
          setReady(true);
          break;
        case "ui/notifications/size-changed":
          setHeight(visualizationFrameHeight(message.params.height));
          break;
        case "openorc/visualization-error":
          fail(message.params.message);
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
    })().catch((error: unknown) => fail(error instanceof Error ? error.message : "This visualization could not open."));
    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("message", receive);
      window.clearTimeout(timeout);
      unwatch?.();
      if (registration) window.openorc.mcpApps.release(registration.id);
    };
  }, [html, onFail]);
  return (
    <>
      {ready ? null : <FrameStatus text="Loading visualization…" />}
      <iframe
        ref={frame}
        title={title}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        style={{ width: "100%", height, border: 0, display: "block", visibility: ready ? "visible" : "hidden" }}
      />
    </>
  );
}
