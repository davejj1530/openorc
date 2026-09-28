import { useEffect, useRef, useState } from "react";
import { AppBridge, PostMessageTransport, type McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import { CallToolResultSchema, ReadResourceResultSchema, ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpAppOpenResult, McpAppReady } from "@openorc/protocol";
import { core } from "../lib/rpc";

export default function McpAppResult({ runId, toolCallId }: { runId: string; toolCallId: string }) {
  const [result, setResult] = useState<McpAppOpenResult | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    if (closed) return;
    let disposed = false;
    let viewId: string | undefined;
    setResult(null);
    void core
      .call("mcpApps.open", { runId, toolCallId })
      .then((value) => {
        if (value.status === "ready") viewId = value.viewId;
        if (disposed) {
          if (viewId) void core.call("mcpApps.close", { viewId });
          return;
        }
        setResult(value);
      })
      .catch((error: unknown) => {
        if (!disposed) setResult({ status: "unavailable", message: error instanceof Error ? error.message : "The app could not be loaded." });
      });
    return () => {
      disposed = true;
      if (viewId) void core.call("mcpApps.close", { viewId });
    };
  }, [runId, toolCallId, attempt, closed]);
  if (closed)
    return (
      <button className="ml-5 text-xs text-ink-3 hover:text-ink" onClick={() => setClosed(false)}>
        Open interactive app
      </button>
    );
  if (!result || result.status === "none") return null;
  if (result.status === "unavailable")
    return (
      <div className="ml-5 py-2 text-xs text-ink-3" role="status">
        {result.message}{" "}
        <button className="underline" onClick={() => setAttempt((n) => n + 1)}>
          Reload app
        </button>
      </div>
    );
  return <AppView key={result.viewId} app={result} close={() => setClosed(true)} />;
}

function hostContext(app: McpAppReady, width: number): McpUiHostContext {
  return {
    toolInfo: { tool: ToolSchema.parse(app.tool) },
    containerDimensions: { width, maxHeight: 720 },
    theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    platform: "desktop",
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function AppView({ app, close }: { app: McpAppReady; close: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(380);
  const [state, setState] = useState("Loading interactive app…");
  useEffect(() => {
    const iframe = frame.current!;
    let disposed = false;
    let registration: { id: string; url: string } | undefined;
    let bridge: AppBridge | undefined;
    let observer: MutationObserver | undefined;
    let resize: ResizeObserver | undefined;
    const timeout = window.setTimeout(() => setState("This app is taking too long to start. The normal result is available in tool details."), 20_000);
    void (async () => {
      registration = await window.openorc.mcpApps.register({ html: app.html, csp: app.csp });
      if (disposed) {
        window.openorc.mcpApps.release(registration.id);
        return;
      }
      const context = () => hostContext(app, iframe.clientWidth);
      bridge = new AppBridge(
        null,
        { name: "OpenOrc", version: "1.0.0" },
        { openLinks: {}, serverTools: {}, serverResources: {}, sandbox: { csp: app.csp, permissions: {} } },
        { hostContext: context() },
      );
      bridge.oncalltool = async ({ name, arguments: args }) => CallToolResultSchema.parse(await core.call("mcpApps.call", { viewId: app.viewId, name, arguments: args ?? {} }));
      bridge.onreadresource = async ({ uri }) => ReadResourceResultSchema.parse(await core.call("mcpApps.read", { viewId: app.viewId, uri }));
      bridge.onopenlink = async ({ url }) => {
        const link = new URL(url);
        if (!["https:", "http:"].includes(link.protocol) || link.username || link.password) throw new Error("This app link is not a supported web URL.");
        window.open(link.href, "_blank", "noopener,noreferrer");
        return {};
      };
      bridge.onrequestdisplaymode = async () => ({ mode: "inline" });
      bridge.onsizechange = ({ height: requested }) => {
        if (typeof requested === "number" && Number.isFinite(requested)) setHeight(Math.min(720, Math.max(180, requested)));
      };
      bridge.onsandboxready = () => {
        void bridge!.sendSandboxResourceReady({ html: "" });
      }; // Main already owns the document and enforces its CSP in HTTP headers.
      bridge.oninitialized = () => {
        window.clearTimeout(timeout);
        if (disposed) return;
        setState("");
        void (async () => {
          await bridge!.sendToolInput({ arguments: app.input });
          await bridge!.sendToolResult(CallToolResultSchema.parse(app.result));
        })().catch((error: unknown) => {
          if (!disposed) setState(error instanceof Error ? error.message : "The app could not read this result.");
        });
      };
      // The SDK validates event.source against this exact proxy window.
      await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
      if (disposed) {
        await bridge.close();
        return;
      }
      observer = new MutationObserver(() => bridge?.setHostContext(context()));
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette", "style"] });
      resize = new ResizeObserver(() => bridge?.setHostContext(context()));
      resize.observe(iframe);
      iframe.src = registration.url;
    })().catch((error: unknown) => {
      if (!disposed) {
        window.clearTimeout(timeout);
        setState(error instanceof Error ? error.message : "The interactive app could not start.");
      }
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      resize?.disconnect();
      window.clearTimeout(timeout);
      if (bridge)
        void bridge
          .teardownResource({}, { timeout: 500 })
          .catch(() => {})
          .finally(() => bridge?.close());
      if (registration) window.openorc.mcpApps.release(registration.id);
    };
  }, [app]);
  return (
    <section aria-label={`${app.title} interactive app`} className="mcp-app-card ml-5 my-2 overflow-hidden rounded-lg border border-line">
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-ink-3">
        <span>{app.title}</span>
        <button onClick={close} className="hover:text-ink">
          Close app
        </button>
      </div>
      {state ? (
        <p role="status" className="px-3 py-2 text-xs text-ink-3">
          {state}
        </p>
      ) : null}
      <iframe ref={frame} title={app.title} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" style={{ width: "100%", height, border: 0, display: "block" }} />
    </section>
  );
}
