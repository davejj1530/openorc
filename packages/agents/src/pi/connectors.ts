import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import type { ConnectorSpec } from "@openorc/protocol";
import { editedConfig, readConfigFile, replaceFile } from "../config-file.js";
import { launchCommand } from "../command-launch.js";
import { readableConnectorError, siteOf, type ConnectorDriver, type ConnectorRow } from "../connectors.js";
import type { AgentLaunchEnvironment } from "../launch-environment.js";
import { piAgentDir } from "./home.js";

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
const reports = z.object({ servers: z.array(z.object({ name: z.string(), scope: z.string(), source: z.string(), state: z.string(), error: z.string().optional() })), errors: z.array(z.string()) });
function specOf(saved: z.infer<typeof savedServer> | undefined): ConnectorSpec | null {
  if (saved?.url) return { kind: "url", url: saved.url, headers: saved.headers ?? {} };
  if (saved?.command) return { kind: "command", command: saved.command, args: saved.args ?? [], env: saved.env ?? {} };
  return null;
}

function statusOf(state: string): ConnectorRow["status"] {
  if (state === "connected") return "connected";
  if (state === "disabled") return "off";
  if (state === "needs-auth") return "needs-sign-in";
  return "failed";
}

export function piConnectorDriver(launch: Pick<AgentLaunchEnvironment, "binary" | "env">): ConnectorDriver {
  const file = path.join(piAgentDir(launch.env["HOME"] || os.homedir(), launch.env), "mcp.json");
  const read = async (file: string) => {
    const saved = await readConfigFile(file, "Pi's mcp.json could not be read. Fix it and try again.");
    return { text: saved.text, servers: config.parse(saved.value).mcpServers };
  };
  const edit = async (name: string, value: unknown) => replaceFile(file, editedConfig((await read(file)).text, ["mcpServers", name], value));
  const run = (args: string[], cwd: string) =>
    new Promise<string>((resolve, reject) => {
      const command = launchCommand(launch.binary, args);
      execFile(command.file, command.args, { ...command.options, cwd, env: { ...launch.env, PWD: cwd, NO_COLOR: "1" }, timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error && !stdout.trim()) reject(new Error("Pi could not check its MCP servers."));
        else resolve(stdout);
      });
    });
  return {
    async read(folder) {
      const listed = reports.parse(JSON.parse(await run(["mcp", "list", "--json"], folder)));
      if (listed.errors.length) throw new Error(readableConnectorError(listed.errors.join("; ")));
      return Promise.all(
        listed.servers.map(async (row): Promise<ConnectorRow> => {
          const spec = specOf((await read(row.source)).servers[row.name]);
          return {
            name: row.name,
            title: row.name,
            source: row.scope === "project" ? "project" : "user",
            kind: spec?.kind ?? null,
            icons: [],
            ...siteOf(spec),
            status: statusOf(row.state),
            ...(row.error ? { error: readableConnectorError(row.error) } : {}),
          };
        }),
      );
    },
    spec: async (name) => specOf((await read(file)).servers[name]),
    async save(name, spec) {
      const rest = { ...(await read(file)).servers[name] };
      for (const key of ["command", "args", "env", "url", "headers", "type"]) delete rest[key];
      await edit(name, spec.kind === "url" ? { ...rest, url: spec.url, headers: spec.headers } : { ...rest, command: spec.command, args: spec.args, env: spec.env });
    },
    remove: (name) => edit(name, undefined),
    setOn: async (name, enabled) => {
      await edit(name, { ...(await read(file)).servers[name], enabled });
    },
    signIn: async (name) => {
      throw new Error(`Sign in from a terminal in your project folder: pi mcp login ${name}`);
    },
    signOut: async (name, folder) => {
      await run(["mcp", "logout", name], folder);
    },
  };
}
