import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { ConnectorSpec } from "@openorc/protocol";
import { editedConfig, readConfigFile, replaceFile } from "../config-file.js";
import { runAgentCommand, siteOf, type ConnectorDriver } from "../connectors.js";
import type { AgentLaunchEnvironment } from "../launch-environment.js";
import { fxHome } from "./home.js";

const server = z
  .object({
    type: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    environment: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .passthrough();
const config = z.object({ mcp: z.record(z.string(), server).optional(), mcpServers: z.record(z.string(), server).optional() });
const listing = z.object({ servers: z.array(z.object({ name: z.string(), source: z.string(), transport: z.string(), status: z.string() })) });

function specOf(saved: z.infer<typeof server> | undefined): ConnectorSpec | null {
  if (saved?.type === "http" && saved.url) return { kind: "url", url: saved.url, headers: saved.headers ?? {} };
  if (saved?.command) return { kind: "command", command: saved.command, args: saved.args ?? [], env: saved.env ?? saved.environment ?? {} };
  return null;
}

/** fx's list command resolves project approval and profile precedence without connecting to servers. */
export function fxConnectorDriver(launch: Pick<AgentLaunchEnvironment, "binary" | "env">): ConnectorDriver {
  const file = path.join(fxHome(launch.env), "mcp.json");
  const read = async () => {
    const saved = await readConfigFile(file, "fx's MCP configuration could not be read. Fix it and try again.");
    const parsed = config.parse(saved.value);
    if (parsed.mcp && parsed.mcpServers) throw new Error("fx's MCP configuration contains both mcp and mcpServers. Keep one section before editing it.");
    return { text: saved.text, key: parsed.mcp ? "mcp" : "mcpServers", servers: parsed.mcp ?? parsed.mcpServers ?? {} };
  };
  const edit = async (name: string, value: unknown) => {
    const saved = await read();
    await replaceFile(file, editedConfig(saved.text, [saved.key, name], value));
  };
  return {
    async read(folder) {
      const result = await promisify(execFile)(launch.binary, ["mcp", "list", "--json"], { cwd: folder, env: { ...launch.env }, timeout: 8000, maxBuffer: 1024 * 1024 });
      const saved = await read();
      return listing.parse(JSON.parse(result.stdout)).servers.map((row) => ({
        name: row.name,
        title: row.name,
        source: row.source === "profile" ? "user" : "project",
        icons: [],
        kind: row.transport === "http" ? "url" : "command",
        status: row.status === "disabled" ? "off" : "configured",
        ...(row.source === "profile" ? siteOf(specOf(saved.servers[row.name])) : {}),
      }));
    },
    spec: async (name) => specOf((await read()).servers[name]),
    async save(name, spec) {
      if (spec.kind === "url" && Object.keys(spec.headers).some((key) => key.toLowerCase() === "authorization"))
        throw new Error("fx manages authorization through fx mcp login or bearer_token_env in its MCP configuration.");
      const rest = { ...(await read()).servers[name] };
      for (const key of ["type", "command", "args", "env", "environment", "url", "headers"]) delete rest[key];
      await edit(name, spec.kind === "url" ? { ...rest, type: "http", url: spec.url, headers: spec.headers } : { ...rest, command: spec.command, args: spec.args, env: spec.env });
    },
    remove: (name) => runAgentCommand(launch, ["mcp", "remove", "--profile", name]),
    setOn: async (name, on) => {
      const saved = (await read()).servers[name];
      if (!saved) throw new Error("This server is not saved in fx's personal configuration.");
      await edit(name, { ...saved, enabled: on });
    },
    signIn: async () => {
      throw new Error("Run fx mcp login <server-name> in a terminal, then refresh Connections.");
    },
    signOut: (name) => runAgentCommand(launch, ["mcp", "logout", name]),
  };
}
