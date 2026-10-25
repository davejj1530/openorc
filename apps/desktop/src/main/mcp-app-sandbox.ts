import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { McpAppDocument, type McpAppCsp } from "@openorc/protocol";
import type { CommandLine, Session, WebContents } from "electron";

/** Only CSP host sources are accepted; never keywords, schemes, paths or header syntax. */
function domains(values: string[] = []): string[] {
  return values.map((value) => {
    if (!/^https:\/\/(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i.test(value)) throw new Error("The app requested an unsupported network domain.");
    const host = new URL(value.replace("*.", "")).hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || /^[\d.]+$/.test(host)) throw new Error("MCP Apps cannot request local network domains.");
    return value;
  });
}
export function appContentSecurityPolicy(csp: McpAppCsp): string {
  const assets = domains(csp.resourceDomains).join(" ");
  const connections = domains(csp.connectDomains).join(" ") || "'none'";
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${assets}`,
    `style-src 'unsafe-inline' ${assets}`,
    `img-src data: blob: ${assets}`,
    `font-src data: ${assets}`,
    `media-src data: blob: ${assets}`,
    `connect-src ${connections}`,
    `frame-src ${domains(csp.frameDomains).join(" ") || "'none'"}`,
    `base-uri ${domains(csp.baseUriDomains).join(" ") || "'none'"}`,
    "object-src 'none'",
    "form-action 'none'",
    "worker-src 'none'",
    "sandbox allow-scripts",
  ].join("; ");
}

/**
 * Gives every sandboxed frame with an opaque origin, which every MCP App and visualization page is, a renderer of its
 * own document. Chromium otherwise shares one renderer among such frames from the same origin, here the sandbox's, so
 * a page in an endless loop kept every other page from loading or drawing. Must run before the app is ready.
 */
export function isolateSandboxFrames(commandLine: Pick<CommandLine, "appendSwitch" | "getSwitchValue">): void {
  const features = commandLine.getSwitchValue("enable-features");
  commandLine.appendSwitch("enable-features", [features, "IsolateSandboxedIframes:grouping/per-document"].filter(Boolean).join(","));
}

/**
 * The window that shows sandbox frames sends WebRTC nothing over UDP, which no content security policy governs, so its
 * WebRTC goes over TCP through the session's proxy (see `SandboxNetwork`). The app itself never uses WebRTC.
 */
export function hostSandboxFrames(contents: Pick<WebContents, "setWebRTCIPHandlingPolicy">): void {
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
}

/**
 * The session of the window that shows sandbox frames. The sandbox makes itself that session's proxy: it answers only
 * its own documents and tunnels nothing, so a connection no policy governs (WebRTC's TCP, also from a frame a page
 * writes itself, which no policy refuses) reaches no host. Only the sandbox, `direct` and the domains an open MCP App
 * declared are reached without it; loopback and link-local addresses get no exemption.
 */
export interface SandboxNetwork {
  session: Pick<Session, "setProxy">;
  /** Hosts the window's own page loads from besides the sandbox: the development server. */
  direct: string[];
}

/** The hosts a document's policy lets it reach, as proxy bypass rules: scheme, host pattern and port, as declared. */
const declaredHosts = (csp: McpAppCsp) => domains([...(csp.resourceDomains ?? []), ...(csp.connectDomains ?? []), ...(csp.frameDomains ?? [])]);

/** Separate loopback origin, with an opaque-origin inner frame and an HTTP-enforced CSP. */
export class McpAppSandbox {
  private readonly documents = new Map<string, { owner: number; html: string; csp: string; hosts: string[] }>();
  private server: Server | null = null;
  private origin = "";
  private network: SandboxNetwork | undefined;
  private bypass = "";
  async start(network?: SandboxNetwork): Promise<void> {
    const server = createServer((req, res) => {
      const [id, page, extra] = (req.url ?? "").slice(1).split("/");
      const document = id ? this.documents.get(id) : undefined;
      // Exact Host defeats DNS rebinding. Tokens are unguessable and never embedded in app HTML.
      if (
        req.method !== "GET" ||
        !req.url?.startsWith("/") ||
        extra !== undefined ||
        req.headers.host !== this.origin.slice("http://".length) ||
        !document ||
        !["proxy", "view"].includes(page ?? "")
      ) {
        res.writeHead(404).end();
        return;
      }
      const nonce = randomBytes(24).toString("base64");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), payment=(), usb=(), display-capture=()",
        "Content-Security-Policy": page === "view" ? document.csp : `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'`,
      });
      res.end(page === "view" ? document.html : proxyDocument(nonce));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("MCP App sandbox did not start.");
    this.server = server;
    this.origin = `http://127.0.0.1:${address.port}`;
    this.network = network;
    await this.route();
  }
  /** Resolves once the session reaches the hosts the document declared, so its first loads go through. */
  async register(owner: number, raw: unknown): Promise<{ id: string; url: string }> {
    const doc = McpAppDocument.parse(raw);
    if (!this.server) throw new Error("The MCP App sandbox is unavailable.");
    if (this.documents.size >= 64) throw new Error("Too many interactive apps are open.");
    const id = randomUUID();
    this.documents.set(id, { owner, html: doc.html, csp: appContentSecurityPolicy(doc.csp), hosts: declaredHosts(doc.csp) });
    await this.route();
    return { id, url: `${this.origin}/${id}/proxy` };
  }
  release(owner: number, id: string): void {
    if (this.documents.get(id)?.owner === owner) this.documents.delete(id);
    void this.route();
  }
  releaseOwner(owner: number): void {
    for (const [id, doc] of this.documents) if (doc.owner === owner) this.documents.delete(id);
    void this.route();
  }
  /** Points the session at this server for every connection but those to the hosts that must be reached directly. */
  private async route(): Promise<void> {
    if (!this.network || !this.server) return;
    const declared = new Set([...this.documents.values()].flatMap((doc) => doc.hosts));
    const bypass = ["<-loopback>", new URL(this.origin).host, ...this.network.direct, ...declared].join(",");
    if (bypass === this.bypass) return;
    this.bypass = bypass;
    await this.network.session
      .setProxy({ mode: "fixed_servers", proxyRules: this.origin, proxyBypassRules: bypass })
      .catch((error: unknown) => console.warn("The MCP App sandbox could not route the window's connections:", error));
  }
  async close(): Promise<void> {
    this.documents.clear();
    const server = this.server;
    this.server = null;
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function proxyDocument(nonce: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,iframe{border:0;margin:0;width:100%;height:100%;display:block;overflow:hidden}</style></head><body>
  <script nonce="${nonce}">
  let view;
  addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.jsonrpc !== '2.0') return;
    if (event.source === parent) {
      if (data.method === 'ui/notifications/sandbox-resource-ready' && !view) {
        view = document.createElement('iframe');
        view.setAttribute('sandbox', 'allow-scripts');
        view.setAttribute('referrerpolicy', 'no-referrer');
        view.src = 'view';
        document.body.append(view);
      } else if (view) view.contentWindow.postMessage(data, '*');
    } else if (view && event.source === view.contentWindow) parent.postMessage(data, '*', event.ports);
  });
  parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready',params:{}}, '*');
  </script></body></html>`;
}
