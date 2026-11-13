import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { ConnectorSpec } from "@openorc/protocol";
import { launchCommand } from "../command-launch.js";
import { editedConfig, readConfigFile, replaceFile } from "../config-file.js";
import { CONNECTOR_READ_WAIT_MS, readableConnectorError, siteOf, type ConnectorDriver, type ConnectorRow } from "../connectors.js";
import { StdioJsonRpc } from "../jsonrpc.js";
import { inFolder, type AgentLaunchEnvironment } from "../launch-environment.js";
import { stopProcess, waitForProcessGroup } from "../process-lifetime.js";
import { ompAgentDir } from "./home.js";

type Launch = Pick<AgentLaunchEnvironment, "binary" | "env">;
type SavedServer = Record<string, unknown>;

const UNREADABLE = "Oh My Pi's mcp.json could not be read. Fix it and try again.";
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): Record<string, string> =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};

/** The user's own MCP servers file, which Oh My Pi's terminal sessions read and OpenOrc hands to its runs. */
export function ompMcpFile(env: NodeJS.ProcessEnv): string {
  return path.join(ompAgentDir(env["HOME"] || os.homedir(), env), "mcp.json");
}

interface McpFile {
  servers: Record<string, SavedServer>;
  /** Names turned off without editing their entries, as Oh My Pi's `/mcp disable` does. */
  disabled: Set<string>;
}

async function readMcpFile(file: string): Promise<{ text: string; read: McpFile }> {
  const { text, value } = await readConfigFile(file, UNREADABLE);
  const servers = isRecord(value["mcpServers"]) ? (value["mcpServers"] as Record<string, unknown>) : {};
  const disabled = Array.isArray(value["disabledServers"]) ? value["disabledServers"].filter((name): name is string => typeof name === "string") : [];
  return { text, read: { servers: Object.fromEntries(Object.entries(servers).filter((entry): entry is [string, SavedServer] => isRecord(entry[1]))), disabled: new Set(disabled) } };
}

function savedAsSpec(saved: SavedServer | undefined): ConnectorSpec | null {
  if (typeof saved?.["url"] === "string") return { kind: "url", url: saved["url"], headers: strings(saved["headers"]) };
  if (typeof saved?.["command"] === "string") return { kind: "command", command: saved["command"], args: Array.isArray(saved["args"]) ? saved["args"].map(String) : [], env: strings(saved["env"]) };
  return null;
}

const isOn = (name: string, saved: SavedServer, file: McpFile) => saved["enabled"] !== false && !file.disabled.has(name);

/** What the connector says over what Oh My Pi has saved, keeping settings OpenOrc does not edit, such as timeouts. */
export function ompServerConfig(saved: SavedServer | undefined, spec: ConnectorSpec): SavedServer {
  const rest = { ...saved };
  for (const key of ["type", "url", "headers", "command", "args", "env"]) delete rest[key];
  if (spec.kind === "url") return { ...rest, type: "http", url: spec.url, ...(Object.keys(spec.headers).length ? { headers: spec.headers } : {}) };
  return { ...rest, type: "stdio", command: spec.command, ...(spec.args.length ? { args: spec.args } : {}), ...(Object.keys(spec.env).length ? { env: spec.env } : {}) };
}

/** One saved server as ACP describes it to `session/new`; null for one it cannot carry. */
function acpServer(name: string, saved: SavedServer): McpServer | null {
  const pairs = (record: Record<string, string>) => Object.entries(record).map(([key, value]) => ({ name: key, value }));
  if (typeof saved["url"] === "string") {
    const type = saved["type"] === "sse" ? "sse" : "http";
    return { type, name, url: saved["url"], headers: pairs(strings(saved["headers"])) };
  }
  if (typeof saved["command"] === "string") return { name, command: saved["command"], args: Array.isArray(saved["args"]) ? saved["args"].map(String) : [], env: pairs(strings(saved["env"])) };
  return null;
}

/**
 * The user's own servers that are on, for a run's `session/new`. Over ACP Oh My Pi reads no MCP configuration of its
 * own, so OpenOrc hands its runs the servers its terminal sessions use.
 */
export async function ompUserServers(env: NodeJS.ProcessEnv): Promise<McpServer[]> {
  const { read } = await readMcpFile(ompMcpFile(env));
  return Object.entries(read.servers).flatMap(([name, saved]) => {
    const server = isOn(name, saved, read) ? acpServer(name, saved) : null;
    return server ? [server] : [];
  });
}

/** A server Oh My Pi said it could not reach, from the note it adds to a new session: `MCP server "x" failed to connect: …`. */
function failures(notes: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const note of notes)
    for (const match of note.matchAll(/MCP server "([^"]+)" failed to connect: ([^\n]*)/g)) found.set(match[1]!, match[2]!.replace(/\s*Its tools are unavailable.*$/, "").trim());
  return found;
}

/**
 * Which servers start, asked of Oh My Pi itself: a throwaway session in a folder of its own is given them, and it says
 * which failed. Nothing is prompted, and the session's file goes with the folder.
 */
async function startFailures(launch: Launch, folder: string, servers: McpServer[]): Promise<Map<string, string>> {
  if (!servers.length) return new Map();
  const sessions = await mkdtemp(path.join(os.tmpdir(), "openorc-omp-mcp-"));
  const command = launchCommand(launch.binary, ["acp", "--session-dir", sessions]);
  const proc = spawn(command.file, command.args, {
    ...command.options,
    cwd: folder,
    env: inFolder({ ...launch.env }, folder),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
  proc.once("error", () => undefined);
  proc.stderr.resume();
  const rpc = new StdioJsonRpc(proc, { includeJsonRpcField: true });
  const notes: string[] = [];
  rpc.on("notification", ({ method, params }) => {
    const update = isRecord(params) && isRecord(params["update"]) ? params["update"] : null;
    const content = update && isRecord(update["content"]) ? update["content"] : null;
    if (method === "session/update" && update?.["sessionUpdate"] === "agent_message_chunk" && typeof content?.["text"] === "string") notes.push(content["text"]);
  });
  try {
    await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "openorc", title: "OpenOrc", version: "0.0.0" } }, CONNECTOR_READ_WAIT_MS);
    const created = await rpc.request<{ sessionId?: string }>("session/new", { cwd: folder, mcpServers: servers }, CONNECTOR_READ_WAIT_MS * 3);
    // Its notes on servers that failed follow the answer by a moment.
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (created.sessionId) await rpc.request("session/close", { sessionId: created.sessionId }, 5_000).catch(() => undefined);
    return failures(notes);
  } finally {
    stopProcess(proc);
    await closed;
    await waitForProcessGroup(proc);
    await rm(sessions, { recursive: true, force: true });
  }
}

/**
 * Oh My Pi's connectors: the user's own `mcp.json` in its folder, which its terminal sessions read. OpenOrc writes
 * that file and hands the servers in it to each run. Signing in to a server is Oh My Pi's own `/mcp` command.
 */
export function ompConnectorDriver(launch: Launch): ConnectorDriver {
  const file = ompMcpFile(launch.env);
  const edit = async (at: string[], value: unknown) => {
    const { text } = await readMcpFile(file);
    await replaceFile(file, editedConfig(text, at, value));
  };
  return {
    async read(folder) {
      const { read } = await readMcpFile(file);
      const named = Object.entries(read.servers);
      const failed = await startFailures(
        launch,
        folder,
        named.flatMap(([name, saved]) => {
          const server = isOn(name, saved, read) ? acpServer(name, saved) : null;
          return server ? [server] : [];
        }),
      ).catch(() => null);
      return named.map(([name, saved]): ConnectorRow => {
        const spec = savedAsSpec(saved);
        const base = { name, title: name, source: "user" as const, kind: spec?.kind ?? null, icons: [], ...siteOf(spec) };
        if (!isOn(name, saved, read)) return { ...base, status: "off" };
        const error = failed?.get(name);
        if (failed === null) return { ...base, status: "failed", error: "Oh My Pi could not be asked whether it starts." };
        if (error === undefined) return { ...base, status: "connected" };
        return { ...base, status: /\b(401|unauthori[sz]ed|oauth|sign in|log ?in)\b/i.test(error) ? "needs-sign-in" : "failed", error: readableConnectorError(error) };
      });
    },
    spec: async (name) => savedAsSpec((await readMcpFile(file)).read.servers[name]),
    save: async (name, spec) => edit(["mcpServers", name], ompServerConfig((await readMcpFile(file)).read.servers[name], spec)),
    remove: (name) => edit(["mcpServers", name], undefined),
    async setOn(name, on) {
      const { read } = await readMcpFile(file);
      await edit(["mcpServers", name, "enabled"], on);
      if (on && read.disabled.has(name))
        await edit(
          ["disabledServers"],
          [...read.disabled].filter((each) => each !== name),
        );
    },
    signIn: () => Promise.reject(new Error("Sign in to this server from Oh My Pi: run omp in a terminal, then /mcp reauth with the server's name.")),
    signOut: () => Promise.reject(new Error("Sign out of this server from Oh My Pi: run omp in a terminal and use /mcp.")),
  };
}
