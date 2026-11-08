import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ConnectorSpec, ConnectorStatus } from "@openorc/protocol";
import {
  CONNECTOR_READ_WAIT_MS,
  CONNECTOR_SIGN_IN_MS,
  delay,
  iconSources,
  readableConnectorError,
  runAgentCommand,
  siteOf,
  whenAborted,
  type ConnectorDriver,
  type ConnectorRow,
} from "../connectors.js";
import type { AgentLaunchEnvironment } from "../launch-environment.js";
import { claudeConfigDir, SHARED_CLAUDE_CONFIG_DIR } from "./config-dir.js";
import { withClaudeControlSession, type ClaudeControlAsk, type ClaudeControlSessionOptions } from "./control-session.js";
import { sharedPluginArgs } from "./plugins.js";
import { sharedClaudeMcpServers } from "./shared-mcp.js";

const STATUS: Record<string, ConnectorStatus> = { connected: "connected", "needs-auth": "needs-sign-in", disabled: "off", failed: "failed" };

function sourceOf(name: string, scope: unknown): ConnectorRow["source"] {
  if (name.startsWith("plugin:")) return "plugin";
  if (name.startsWith("claude.ai ") || scope === "claudeai") return "account";
  return scope === "project" || scope === "local" ? "project" : "user";
}

/** `plugin:vercel:vercel` and `claude.ai Figma` read as `vercel` and `Figma`. */
function titleOf(name: string): string {
  if (name.startsWith("claude.ai ")) return name.slice("claude.ai ".length);
  return name.startsWith("plugin:") ? (name.split(":").at(-1) ?? name) : name;
}

interface StatusRow {
  name: string;
  status: string;
  scope?: unknown;
  transport?: unknown;
  error?: unknown;
  serverInfo?: { icons?: unknown };
}

async function askStatus(ask: ClaudeControlAsk): Promise<StatusRow[]> {
  const rows = (await ask({ subtype: "mcp_status" }))["mcpServers"];
  return Array.isArray(rows) ? (rows as StatusRow[]).filter((row) => typeof row?.name === "string") : [];
}

/** A server is `pending` while it connects, which a slow remote one can stay for seconds after the CLI starts. */
async function settledStatus(ask: ClaudeControlAsk): Promise<StatusRow[]> {
  const deadline = Date.now() + CONNECTOR_READ_WAIT_MS;
  for (;;) {
    const rows = await askStatus(ask);
    if (Date.now() >= deadline || !rows.some((row) => row.status === "pending")) return rows;
    await delay(400);
  }
}

function kindOf(transport: unknown): ConnectorRow["kind"] {
  if (!transport) return null;
  return transport === "stdio" ? "command" : "url";
}

function rowOf(server: StatusRow, saved: Record<string, unknown>): ConnectorRow {
  const error = typeof server.error === "string" && server.error ? { error: readableConnectorError(server.error) } : {};
  return {
    name: server.name,
    title: titleOf(server.name),
    source: sourceOf(server.name, server.scope),
    kind: kindOf(server.transport),
    status: STATUS[server.status] ?? "failed",
    ...error,
    icons: iconSources(server.serverInfo?.icons),
    ...siteOf(savedAsSpec(saved[server.name])),
  };
}

function savedAsSpec(saved: unknown): ConnectorSpec | null {
  if (!saved || typeof saved !== "object") return null;
  const { command, args, env, url, headers } = saved as Record<string, unknown>;
  if (typeof url === "string") return { kind: "url", url, headers: (headers as Record<string, string> | undefined) ?? {} };
  if (typeof command === "string") return { kind: "command", command, args: (args as string[] | undefined) ?? [], env: (env as Record<string, string> | undefined) ?? {} };
  return null;
}

/**
 * Claude's connectors as `launch` sees them. Reads and sign-ins belong to the account `launch` runs as, which sees the
 * CLI login's servers the way a run does, so its answers are true of its runs. Saving and removing write the servers
 * every account shares, so they run on the CLI login's own environment.
 */
export function claudeConnectorDriver(launch: Pick<AgentLaunchEnvironment, "binary" | "env">, off: () => string[]): ConnectorDriver {
  const session = async <T>(folder: string, task: string, timeoutMs: number, body: (ask: ClaudeControlAsk) => Promise<T>): Promise<T> => {
    const shared = launch.env[SHARED_CLAUDE_CONFIG_DIR];
    const servers = sharedClaudeMcpServers(shared);
    const dir = Object.keys(servers).length ? await mkdtemp(path.join(os.tmpdir(), "openorc-connectors-")) : null;
    try {
      const args = sharedPluginArgs(shared);
      if (dir) {
        const file = path.join(dir, "mcp.json");
        await writeFile(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
        args.push("--mcp-config", file);
      }
      const options: ClaudeControlSessionOptions = {
        task,
        cwd: folder,
        settingSources: "all",
        userMcp: true,
        args,
        timeoutMs,
      };
      return await withClaudeControlSession(launch, options, async (ask) => {
        await ask({ subtype: "initialize", hooks: {} });
        return body(ask);
      });
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  };
  const saved = () => sharedClaudeMcpServers(claudeConfigDir(os.homedir(), launch.env));

  return {
    async read(folder) {
      // Read with every server on, so one turned off in OpenOrc is still listed, as off, for as long as Claude has it.
      const turnedOff = new Set(off());
      const servers = saved();
      const rows = (await session(folder, "reading connectors", 25_000, settledStatus)).map((server) => rowOf(server, servers));
      return rows.map((row) =>
        turnedOff.has(row.name) ? { name: row.name, title: row.title, source: row.source, kind: row.kind, status: "off" as const, icons: row.icons, ...(row.site ? { site: row.site } : {}) } : row,
      );
    },
    spec: async (name) => savedAsSpec(saved()[name]),
    async save(name, spec) {
      const previous = saved()[name] as { type?: unknown } | undefined;
      if (previous) await runAgentCommand(launch, ["mcp", "remove", "--scope", "user", name]);
      const config =
        spec.kind === "command" ? { type: "stdio", command: spec.command, args: spec.args, env: spec.env } : { type: previous?.type === "sse" ? "sse" : "http", url: spec.url, headers: spec.headers };
      // Claude takes the server only as an argument, so its headers and variables are in the process list for the moment
      // the command runs, as when it is added in a terminal. Claude then keeps them in plain text in its own file.
      await runAgentCommand(launch, ["mcp", "add-json", "--scope", "user", name, JSON.stringify(config)]);
    },
    remove: (name) => runAgentCommand(launch, ["mcp", "remove", "--scope", "user", name]),
    signIn: (name, folder, open, signal) =>
      session(folder, "signing in to a connector", CONNECTOR_SIGN_IN_MS, async (ask) => {
        const before = (await settledStatus(ask)).find((row) => row.name === name);
        if (before?.status === "connected" || signal.aborted) return;
        const address = (await ask({ subtype: "mcp_authenticate", serverName: name }))["authUrl"];
        if (typeof address === "string" && !signal.aborted) open(address);
        const signedIn = (async () => {
          while (!signal.aborted) {
            if ((await askStatus(ask)).some((row) => row.name === name && row.status === "connected")) return;
            await delay(1000);
          }
        })();
        await Promise.race([signedIn, whenAborted(signal)]);
      }),
    signOut: (name, folder) =>
      session(folder, "signing out of a connector", 25_000, async (ask) => {
        await settledStatus(ask);
        await ask({ subtype: "mcp_clear_auth", serverName: name });
      }),
  };
}
