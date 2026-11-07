import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import type { ConnectorSpec, ConnectorStatus } from "@openorc/protocol";
import { launchCommand } from "../command-launch.js";
import { CONNECTOR_READ_WAIT_MS, delay, readableConnectorError, whenAborted, type ConnectorDriver, type ConnectorRow } from "../connectors.js";
import { inFolder, type AgentLaunchEnvironment } from "../launch-environment.js";
import { stopProcess, waitForProcessGroup } from "../process-lifetime.js";

type Launch = Pick<AgentLaunchEnvironment, "binary" | "env">;
type SavedServer = Record<string, unknown>;
type Api = <T>(method: string, route: string, body?: unknown) => Promise<T>;

const STATUS: Record<string, ConnectorStatus> = { connected: "connected", needs_auth: "needs-sign-in", disabled: "off", failed: "failed" };

interface ServiceServer {
  name: string;
  title?: string;
  integrationID?: string;
  status: { status: string; error?: string };
}
interface ConfigEntry {
  type: string;
  path?: string;
  integrationID?: string;
  info?: { mcp?: Record<string, unknown> };
}

/**
 * The servers in one configuration file and where each sits: OpenCode 2 keeps them under `mcp.servers`, and still reads
 * files that list them straight under `mcp`, as earlier versions wrote.
 */
export function savedOpenCodeServers(mcp: Record<string, unknown> | undefined): Map<string, { server: SavedServer; at: string[] }> {
  const found = new Map<string, { server: SavedServer; at: string[] }>();
  for (const [name, value] of Object.entries(mcp ?? {})) {
    if (value && typeof value === "object" && "type" in value) found.set(name, { server: value as SavedServer, at: ["mcp", name] });
  }
  for (const [name, value] of Object.entries((mcp?.["servers"] ?? {}) as Record<string, unknown>)) {
    if (value && typeof value === "object") found.set(name, { server: value as SavedServer, at: ["mcp", "servers", name] });
  }
  return found;
}

function savedAsSpec(saved: SavedServer | undefined): ConnectorSpec | null {
  if (saved?.["type"] === "remote" && typeof saved["url"] === "string") return { kind: "url", url: saved["url"], headers: (saved["headers"] as Record<string, string> | undefined) ?? {} };
  const command = saved?.["command"];
  if (saved?.["type"] === "local" && Array.isArray(command) && typeof command[0] === "string") {
    return { kind: "command", command: command[0], args: command.slice(1) as string[], env: (saved["environment"] as Record<string, string> | undefined) ?? {} };
  }
  return null;
}

/** What the connector says over what OpenCode has saved, keeping settings OpenOrc does not edit, such as timeouts. */
export function openCodeServerConfig(saved: SavedServer | undefined, spec: ConnectorSpec): SavedServer {
  const rest = { ...saved };
  for (const key of ["type", "url", "headers", "command", "environment"]) delete rest[key];
  if (spec.kind === "url") return { ...rest, type: "remote", url: spec.url, ...(Object.keys(spec.headers).length ? { headers: spec.headers } : {}) };
  return { ...rest, type: "local", command: [spec.command, ...spec.args], ...(Object.keys(spec.env).length ? { environment: spec.env } : {}) };
}

/** Changes one value in a configuration file the user may have written by hand, leaving their comments and order alone. */
export function editedOpenCodeConfig(text: string, at: string[], value: unknown): string {
  return applyEdits(text, modify(text, at, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
}

function configFile(env: NodeJS.ProcessEnv): string {
  const dir = path.join(env["XDG_CONFIG_HOME"] || path.join(env["HOME"] || os.homedir(), ".config"), "opencode");
  return [path.join(dir, "opencode.jsonc"), path.join(dir, "opencode.json")].find((file) => existsSync(file)) ?? path.join(dir, "opencode.jsonc");
}

async function readConfig(file: string): Promise<{ text: string; mcp: Record<string, unknown> | undefined }> {
  const text = await readFile(file, "utf8").catch(() => "{}\n");
  const errors: ParseError[] = [];
  const config = parse(text, errors, { allowTrailingComma: true }) as { mcp?: Record<string, unknown> } | null;
  if (errors.length) throw new Error("OpenCode's configuration file could not be read. Fix it and try again.");
  return { text, mcp: config?.mcp };
}

/** Writes the whole file at once. A configuration kept elsewhere behind a link, as dotfiles often are, is written where it lives. */
async function replaceFile(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const target = await realpath(file).catch(() => file);
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { mode });
  await rename(temporary, target);
}

/**
 * A private OpenCode service for one question, so the answer takes no part in the user's own background one. Its
 * sign-ins land in the same store, where every OpenCode process reads them.
 */
async function withService<T>(launch: Launch, folder: string, timeoutMs: number, work: (api: Api) => Promise<T>): Promise<T> {
  const command = launchCommand(launch.binary, ["serve", "--port", "0", "--hostname", "127.0.0.1"]);
  const proc = spawn(command.file, command.args, {
    ...command.options,
    cwd: folder,
    env: inFolder({ ...launch.env }, folder),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
  proc.stderr.resume();
  const output = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  let timer: NodeJS.Timeout | undefined;
  const failed = new Promise<never>((_, reject) => {
    proc.once("error", () => reject(new Error("OpenCode could not start")));
    proc.once("close", () => reject(new Error("OpenCode stopped before it answered")));
    timer = setTimeout(() => reject(new Error("OpenCode took too long to answer")), timeoutMs);
  });
  const started = new Promise<{ url: string; password: string }>((resolve) => {
    let url = "";
    let password = "";
    output.on("line", (line) => {
      url = /listening on (http\S+)/.exec(line)?.[1] ?? url;
      password = /server password (\S+)/.exec(line)?.[1] ?? password;
      if (url && password) resolve({ url, password });
    });
  });
  try {
    return await Promise.race([
      failed,
      started.then(({ url, password }) => {
        const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
        return work(async (method, route, body) => {
          const address = new URL(route, url);
          address.searchParams.set("location[directory]", folder);
          const answer = await fetch(address, { method, headers: { authorization, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
          if (answer.status === 404) throw new Error("This version of OpenCode can't manage connectors. Update OpenCode and try again.");
          if (!answer.ok) throw new Error(readableConnectorError(await answer.text()));
          const text = await answer.text();
          return (text ? JSON.parse(text) : null) as never;
        });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    output.close();
    stopProcess(proc);
    await closed;
    await waitForProcessGroup(proc);
  }
}

const servicePath = (integrationID: string, rest = "") => `/api/integration/${encodeURIComponent(integrationID)}${rest}`;

/** A file from an integration is the account's, one beside the user's own configuration is the user's, and any other a project's. */
function sourceOf(entry: ConfigEntry, userFile: string): ConnectorRow["source"] {
  if (entry.integrationID) return "account";
  return entry.path && path.dirname(entry.path) === path.dirname(userFile) ? "user" : "project";
}

export function openCodeConnectorRows(entries: ConfigEntry[], servers: ServiceServer[], userFile: string): ConnectorRow[] {
  const known = new Map<string, Pick<ConnectorRow, "source" | "kind">>();
  for (const entry of entries) {
    if (entry.type !== "document") continue;
    const source = sourceOf(entry, userFile);
    for (const [name, { server }] of savedOpenCodeServers(entry.info?.mcp)) known.set(name, { source, kind: savedAsSpec(server)?.kind ?? null });
  }
  return servers.map((server) => ({
    name: server.name,
    title: server.title || server.name,
    source: known.get(server.name)?.source ?? (server.integrationID ? "account" : "user"),
    kind: known.get(server.name)?.kind ?? null,
    status: STATUS[server.status.status] ?? "failed",
    ...(server.status.status === "failed" && server.status.error ? { error: readableConnectorError(server.status.error) } : {}),
    icons: [],
  }));
}

/** OpenCode's connectors: its own service answers and signs in, and its configuration file holds what the user saved. */
export function openCodeConnectorDriver(launch: Launch): ConnectorDriver {
  const listServers = async (api: Api) => (await api<{ data: ServiceServer[] }>("GET", "/api/mcp")).data;
  /** The service loads servers on the first question it gets, so the first answers come back short. */
  const settledServers = async (api: Api, names: Set<string>) => {
    const deadline = Date.now() + CONNECTOR_READ_WAIT_MS;
    for (;;) {
      const servers = await listServers(api);
      const seen = new Set(servers.map((server) => server.name));
      const settled = [...names].every((name) => seen.has(name)) && !servers.some((server) => server.status.status === "pending");
      if (settled || Date.now() >= deadline) return servers;
      await delay(400);
    }
  };
  const integrationOf = async (api: Api, name: string) => {
    const servers = await settledServers(api, new Set([name]));
    const id = servers.find((server) => server.name === name)?.integrationID;
    if (!id) throw new Error(`${name} has no sign-in on OpenCode.`);
    return id;
  };
  const edit = async (name: string, change: (found: { server: SavedServer; at: string[] } | undefined, at: string[]) => { at: string[]; value: unknown }) => {
    const file = configFile(launch.env);
    const { text, mcp } = await readConfig(file);
    const found = savedOpenCodeServers(mcp).get(name);
    const { at, value } = change(found, found?.at ?? ["mcp", "servers", name]);
    await replaceFile(file, editedOpenCodeConfig(text, at, value));
  };

  return {
    read: (folder) =>
      withService(launch, folder, 25_000, async (api) => {
        const entries = await api<ConfigEntry[]>("GET", "/api/config");
        const names = new Set(entries.flatMap((entry) => (entry.type === "document" ? [...savedOpenCodeServers(entry.info?.mcp).keys()] : [])));
        return openCodeConnectorRows(entries, await settledServers(api, names), configFile(launch.env));
      }),
    spec: async (name) => savedAsSpec(savedOpenCodeServers((await readConfig(configFile(launch.env))).mcp).get(name)?.server),
    save: (name, spec) => edit(name, (found, at) => ({ at, value: openCodeServerConfig(found?.server, spec) })),
    remove: (name) => edit(name, (_found, at) => ({ at, value: undefined })),
    setOn: (name, on) =>
      edit(name, (found, at) => {
        // A file from an earlier version says `enabled`; this version says `disabled`.
        const legacy = found?.at.length === 2;
        return legacy ? { at: [...at, "enabled"], value: on } : { at: [...at, "disabled"], value: on ? undefined : true };
      }),
    signIn: (name, folder, open, signal) =>
      withService(launch, folder, 5 * 60_000, async (api) => {
        const id = await integrationOf(api, name);
        const integration = (await api<{ data?: { methods?: { id: string; type: string }[] } } & { methods?: { id: string; type: string }[] }>("GET", servicePath(id))) ?? {};
        const method = (integration.data?.methods ?? integration.methods ?? []).find((entry) => entry.type === "oauth");
        if (!method) throw new Error(`${name} has no sign-in on OpenCode.`);
        const { data: attempt } = await api<{ data: { attemptID: string; url: string } }>("POST", servicePath(id, "/connect/oauth"), { methodID: method.id });
        if (!signal.aborted) open(attempt.url);
        const finished = (async () => {
          while (!signal.aborted) {
            const answer = await api<{ data?: { status?: string; message?: string }; status?: string; message?: string }>(
              "GET",
              servicePath(id, `/connect/oauth/${encodeURIComponent(attempt.attemptID)}`),
            );
            const state = answer.data ?? answer;
            if (state.status === "complete") return;
            if (state.status && state.status !== "pending") throw new Error(readableConnectorError(state.message ?? "Sign-in did not finish"));
            await delay(1000);
          }
        })();
        await Promise.race([finished, whenAborted(signal)]);
      }),
    signOut: (name, folder) =>
      withService(launch, folder, 25_000, async (api) => {
        const id = await integrationOf(api, name);
        const answer = await api<{ data?: { connections?: { type: string; id: string }[] }; connections?: { type: string; id: string }[] }>("GET", servicePath(id));
        for (const connection of answer.data?.connections ?? answer.connections ?? []) {
          if (connection.type === "credential") await api("DELETE", `/api/credential/${encodeURIComponent(connection.id)}`);
        }
      }),
  };
}
