import path from "node:path";
import { z } from "zod";
import type { ConnectorSpec } from "@openorc/protocol";
import { editedConfig, readConfigFile, replaceFile } from "../config-file.js";
import { siteOf, type ConnectorDriver, type ConnectorRow } from "../connectors.js";
import type { AgentLaunchEnvironment } from "../launch-environment.js";
import { antigravityConfig, antigravityProjectDirectories } from "./home.js";

const savedServer = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    serverUrl: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    disabled: z.boolean().optional(),
  })
  .passthrough();
const config = z.object({ mcpServers: z.record(z.string(), savedServer).default({}) });

function specOf(saved: z.infer<typeof savedServer> | undefined): ConnectorSpec | null {
  if (saved?.serverUrl) return { kind: "url", url: saved.serverUrl, headers: saved.headers ?? {} };
  if (saved?.command) return { kind: "command", command: saved.command, args: saved.args ?? [], env: saved.env ?? {} };
  return null;
}

/** Native configuration is not a health check: enabled servers stay "Configured" until the CLI connects them. */
export function antigravityConnectorDriver(launch: Pick<AgentLaunchEnvironment, "binary" | "env">): ConnectorDriver {
  const file = path.join(antigravityConfig(launch.env), "mcp_config.json");
  const read = async (file: string) => {
    const saved = await readConfigFile(file, "Antigravity's MCP configuration could not be read. Fix it and try again.");
    return { text: saved.text, servers: config.parse(saved.value).mcpServers };
  };
  const edit = async (name: string, value: unknown) => replaceFile(file, editedConfig((await read(file)).text, ["mcpServers", name], value));
  return {
    async read(folder) {
      const rows = new Map<string, ConnectorRow>();
      const files = [file, ...(await antigravityProjectDirectories(folder)).map((dir) => path.join(dir, ".agents", "mcp_config.json"))];
      for (const source of files)
        for (const [name, saved] of Object.entries((await read(source)).servers)) {
          const spec = specOf(saved);
          rows.set(name, { name, title: name, source: source === file ? "user" : "project", kind: spec?.kind ?? null, icons: [], ...siteOf(spec), status: saved.disabled ? "off" : "configured" });
        }
      return [...rows.values()];
    },
    spec: async (name) => specOf((await read(file)).servers[name]),
    async save(name, spec) {
      const rest = { ...(await read(file)).servers[name] };
      for (const key of ["command", "args", "env", "serverUrl", "headers"]) delete rest[key];
      await edit(name, spec.kind === "url" ? { ...rest, serverUrl: spec.url, headers: spec.headers } : { ...rest, command: spec.command, args: spec.args, env: spec.env });
    },
    remove: (name) => edit(name, undefined),
    setOn: async (name, on) => edit(name, { ...(await read(file)).servers[name], disabled: !on }),
    signIn: async () => {
      throw new Error("Manage this server's sign-in in Antigravity CLI with /mcp.");
    },
    signOut: async () => {
      throw new Error("Manage this server's sign-in in Antigravity CLI with /mcp.");
    },
  };
}
