import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { ConnectorSpec } from "@openorc/protocol";
import { launchCommand } from "../command-launch.js";
import { editedConfig, readConfigFile, replaceFile } from "../config-file.js";
import { readableConnectorError, siteOf, type ConnectorDriver, type ConnectorRow } from "../connectors.js";
import { stripAnsi } from "../jsonrpc.js";
import type { AgentLaunchEnvironment } from "../launch-environment.js";

const savedServer = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
const config = z.object({ mcpServers: z.record(z.string(), savedServer).default({}) });
type SavedServer = z.infer<typeof savedServer>;
function specOf(saved: SavedServer | undefined): ConnectorSpec | null {
  if (saved?.url) return { kind: "url", url: saved.url, headers: saved.headers ?? {} };
  if (saved?.command) return { kind: "command", command: saved.command, args: saved.args ?? [], env: saved.env ?? {} };
  return null;
}

/** Native MCP status is checked by Cursor; configuration alone never counts as a working connection. */
export function cursorConnectorStatus(output: string, name: string): Pick<ConnectorRow, "status" | "error"> {
  const line = stripAnsi(output)
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${name}: `));
  const status = line?.slice(name.length + 2).trim();
  if (status === "ready") return { status: "connected" };
  if (status === "disabled") return { status: "off" };
  if (status === "requires_authentication") return { status: "needs-sign-in" };
  return { status: "failed", error: readableConnectorError(status || "Cursor did not report this server's status.") };
}

export function cursorConnectorDriver(launch: Pick<AgentLaunchEnvironment, "binary" | "env">): ConnectorDriver {
  const file = path.join(launch.env["HOME"] || os.homedir(), ".cursor", "mcp.json");
  const read = async (file: string) => {
    const saved = await readConfigFile(file, "Cursor's mcp.json could not be read. Fix it and try again.");
    return { text: saved.text, servers: config.parse(saved.value).mcpServers };
  };
  const edit = async (name: string, value: unknown) => replaceFile(file, editedConfig((await read(file)).text, ["mcpServers", name], value));
  return {
    async read(folder) {
      const [user, project] = await Promise.all([read(file), read(path.join(folder, ".cursor", "mcp.json"))]);
      const command = launchCommand(launch.binary, ["mcp", "list"]);
      const output = await promisify(execFile)(command.file, command.args, { ...command.options, cwd: folder, env: { ...launch.env, NO_COLOR: "1" }, timeout: 20_000, maxBuffer: 1024 * 1024 }).then(
        (result) => result.stdout,
        () => "",
      );
      return Object.entries({ ...user.servers, ...project.servers }).map(([name, saved]): ConnectorRow => {
        const spec = specOf(saved);
        return {
          name,
          title: name,
          kind: spec?.kind ?? null,
          source: Object.hasOwn(project.servers, name) ? "project" : "user",
          icons: [],
          switchable: false,
          ...siteOf(spec),
          ...cursorConnectorStatus(output, name),
        };
      });
    },
    spec: async (name) => specOf((await read(file)).servers[name]),
    async save(name, spec) {
      const rest = { ...(await read(file)).servers[name] };
      for (const key of ["command", "args", "env", "url", "headers", "type"]) delete rest[key];
      await edit(name, spec.kind === "url" ? { ...rest, url: spec.url, headers: spec.headers } : { ...rest, command: spec.command, args: spec.args, env: spec.env });
    },
    remove: (name) => edit(name, undefined),
    setOn: async () => {
      throw new Error("Enable or disable this server with cursor-agent mcp enable or cursor-agent mcp disable in your project folder.");
    },
    signIn: async (name) => {
      throw new Error(`Sign in from a terminal in your project folder: cursor-agent mcp login ${name}`);
    },
    signOut: async () => {
      throw new Error("Manage this server's sign-in in Cursor.");
    },
  };
}
