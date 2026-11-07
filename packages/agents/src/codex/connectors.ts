import type { ConnectorSpec } from "@openorc/protocol";
import { CONNECTOR_SIGN_IN_MS, iconSources, readableConnectorError, runAgentCommand, siteOf, whenAborted, type ConnectorDriver, type ConnectorRow } from "../connectors.js";
import type { AgentLaunchEnvironment } from "../launch-environment.js";
import type { StdioJsonRpc } from "../jsonrpc.js";
import { withCodexConnection } from "./connection.js";

/** Codex's own way to its apps, which `app/list` shows one by one. */
const INTERNAL = new Set(["codex_app", "codex_apps"]);

type SavedServer = Record<string, unknown>;
interface ConfigRead {
  config: { mcp_servers?: Record<string, SavedServer> };
  layers?: { name: { type?: string }; config?: { mcp_servers?: Record<string, SavedServer> } }[];
}
interface StatusPage {
  data: { name: string; authStatus?: string; tools?: Record<string, unknown>; toolsError?: string | null; pluginId?: string | null; serverInfo?: { icons?: unknown; title?: string | null } | null }[];
  nextCursor?: string | null;
}

function savedAsSpec(saved: SavedServer | undefined): ConnectorSpec | null {
  if (typeof saved?.["url"] === "string") return { kind: "url", url: saved["url"], headers: (saved["http_headers"] as Record<string, string> | undefined) ?? {} };
  if (typeof saved?.["command"] === "string")
    return { kind: "command", command: saved["command"], args: (saved["args"] as string[] | undefined) ?? [], env: (saved["env"] as Record<string, string> | undefined) ?? {} };
  return null;
}

/** What the connector says over what Codex has saved, keeping settings OpenOrc does not edit, such as tool approvals. */
export function codexServerConfig(saved: SavedServer | undefined, spec: ConnectorSpec): SavedServer {
  const rest = { ...saved };
  for (const key of ["url", "http_headers", "command", "args", "env"]) delete rest[key];
  return spec.kind === "url" ? { ...rest, url: spec.url, http_headers: spec.headers } : { ...rest, command: spec.command, args: spec.args, env: spec.env };
}

const layerServers = (read: ConfigRead, type: string): Record<string, SavedServer> => read.layers?.find((layer) => layer.name.type === type)?.config?.mcp_servers ?? {};

function sourceOf(name: string, user: Record<string, SavedServer>, project: Record<string, SavedServer>): ConnectorRow["source"] {
  if (name in user) return "user";
  return name in project ? "project" : "plugin";
}

export function codexConnectorRows(read: ConfigRead, servers: StatusPage["data"]): ConnectorRow[] {
  const user = layerServers(read, "user");
  const project = layerServers(read, "project");
  return servers
    .filter((server) => !INTERNAL.has(server.name))
    .map((server): ConnectorRow => {
      const saved = read.config.mcp_servers?.[server.name];
      const spec = savedAsSpec(saved);
      const icons = iconSources(server.serverInfo?.icons);
      const base = { name: server.name, title: server.name, source: sourceOf(server.name, user, project), kind: spec?.kind ?? null, icons, ...siteOf(spec) };
      if (saved?.["enabled"] === false) return { ...base, status: "off" };
      if (server.authStatus === "notLoggedIn") return { ...base, status: "needs-sign-in" };
      if (server.toolsError) return { ...base, status: "failed", error: readableConnectorError(server.toolsError) };
      return { ...base, status: "connected" };
    });
}

/** Codex's connectors. Nothing here needs a thread: the app-server answers for the folder it starts in and writes its own config. */
export function codexConnectorDriver(launch: Pick<AgentLaunchEnvironment, "binary" | "env">): ConnectorDriver {
  const connect = <T>(work: (rpc: StdioJsonRpc) => Promise<T>, options: { cwd?: string; timeoutMs?: number } = {}) =>
    withCodexConnection({ binary: launch.binary, env: launch.env, timeoutMs: 25_000, ...options }, work);
  const write = (rpc: StdioJsonRpc, keyPath: string, value: unknown) => rpc.request("config/value/write", { keyPath, value, mergeStrategy: "replace" });
  const configRead = (rpc: StdioJsonRpc, cwd?: string) => rpc.request<ConfigRead>("config/read", { includeLayers: true, ...(cwd ? { cwd } : {}) });

  return {
    read: (folder) =>
      connect(
        async (rpc) => {
          const read = await configRead(rpc, folder);
          const servers: StatusPage["data"] = [];
          let cursor: string | null = null;
          // Each page answers once its servers have finished starting, so what it says is settled.
          do {
            const page: StatusPage = await rpc.request("mcpServerStatus/list", { cursor, limit: 100 }, 20_000);
            servers.push(...page.data);
            cursor = page.nextCursor ?? null;
          } while (cursor);
          return codexConnectorRows(read, servers);
        },
        { cwd: folder },
      ),
    spec: (name) => connect(async (rpc) => savedAsSpec(layerServers(await configRead(rpc), "user")[name])),
    save: (name, spec) =>
      connect(async (rpc) => {
        const saved = layerServers(await configRead(rpc), "user")[name];
        await write(rpc, `mcp_servers.${name}`, codexServerConfig(saved, spec));
      }),
    remove: (name) => connect((rpc) => write(rpc, `mcp_servers.${name}`, null)).then(() => undefined),
    setOn: (name, on) => connect((rpc) => write(rpc, `mcp_servers.${name}.enabled`, on)).then(() => undefined),
    signIn: (name, folder, open, signal) =>
      connect(
        async (rpc) => {
          const completed = new Promise<void>((resolve, reject) => {
            rpc.on("notification", ({ method, params }) => {
              const done = params as { name?: string; success?: boolean; error?: string | null } | undefined;
              if (method !== "mcpServer/oauthLogin/completed" || done?.name !== name) return;
              if (done.success) resolve();
              else reject(new Error(readableConnectorError(done.error ?? "Sign-in failed")));
            });
          });
          const { authorizationUrl } = await rpc.request<{ authorizationUrl: string }>("mcpServer/oauth/login", { name });
          if (!signal.aborted) open(authorizationUrl);
          await Promise.race([completed, whenAborted(signal)]);
        },
        { cwd: folder, timeoutMs: CONNECTOR_SIGN_IN_MS },
      ),
    signOut: (name) => runAgentCommand(launch, ["mcp", "logout", name]),
  };
}
