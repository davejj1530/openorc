import { randomUUID } from "node:crypto";

type Reply = { status: number; body: unknown };

/**
 * The server's interactive MCP apps of a cloud thread (its mcp-app-asks.ts), behind the `interactiveApp` capability: an
 * app a test lays out by tool call, opened as a view, its reads answered, its calls kept, as the thread's live process
 * would answer them.
 */
export class StandInMcpApps {
  /** The app each tool call opens, by tool call id. */
  readonly apps = new Map<string, { title: string; html: string; tools: string[] }>();
  /** Every action a view called, in order. */
  readonly called: { viewId: string; name: string; arguments: unknown; who: string }[] = [];
  private readonly views = new Map<string, string>();

  constructor(private readonly deps: { available: () => boolean }) {}

  route(request: { method: string; path: string }, who: string, body: unknown): Reply | null {
    const match = /^\/hosted\/threads\/[^/]+\/mcp-apps(?:\/([^/]+)(?:\/(read|call))?)?$/.exec(request.path);
    if (!match) return null;
    if (!this.deps.available()) return { status: 503, body: { message: "Interactive tool apps aren't available in this cloud thread yet." } };
    const [, viewId, action] = match;
    if (!viewId && request.method === "POST") return { status: 200, body: this.open((body as { toolCallId: string }).toolCallId) };
    if (!viewId || !this.views.has(decodeURIComponent(viewId))) return { status: 404, body: { message: "This app's agent is no longer running. Reopen it from the thread." } };
    const view = decodeURIComponent(viewId);
    if (request.method === "DELETE") {
      this.views.delete(view);
      return { status: 200, body: null };
    }
    if (action === "read") return { status: 200, body: { contents: [{ uri: (body as { uri: string }).uri, mimeType: "text/plain", text: "" }] } };
    const call = body as { name: string; arguments: unknown };
    const app = this.apps.get(this.views.get(view)!)!;
    if (!app.tools.includes(call.name)) return { status: 400, body: { message: "This tool is not available to this app." } };
    this.called.push({ viewId: view, name: call.name, arguments: call.arguments, who });
    return { status: 200, body: { content: [{ type: "text", text: `${call.name} done` }] } };
  }

  private open(toolCallId: string) {
    const app = this.apps.get(toolCallId);
    if (!app) return { status: "none" };
    const viewId = randomUUID();
    this.views.set(viewId, toolCallId);
    return { status: "ready", viewId, title: app.title, html: app.html, csp: {}, tool: { name: "draw", inputSchema: { type: "object" } }, input: {}, result: {} };
  }
}
