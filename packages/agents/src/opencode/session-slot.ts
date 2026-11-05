import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { planConfig } from "../acp/plan-config.js";
import { StdioJsonRpc } from "../jsonrpc.js";
import { stopProcess, waitForProcessGroup } from "../process-lifetime.js";
import { atLeast, SessionRefused, versionReader, type AgentHome, type SavedSession, type SessionSlot } from "../session-slot.js";
import { OpenCodeRunParser } from "./run-json.js";

const PART = /^ses_[A-Za-z0-9]{1,96}\.json$/;
const words = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One session as OpenCode's own export prints it. */
interface Exported {
  info: { id: string };
  messages: unknown[];
}

function exported(bytes: Buffer, id: string): Exported {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new SessionRefused("OpenCode's export of this conversation does not read.");
  }
  const value = parsed as Partial<Exported> | null;
  if (!value || typeof value !== "object" || !value.info || typeof value.info !== "object" || !Array.isArray(value.messages))
    throw new SessionRefused("OpenCode's export of this conversation is not one this version of OpenOrc reads.");
  if (value.info.id !== id) throw new SessionRefused("OpenCode exported another conversation than the one asked for.");
  return value as Exported;
}

/** Keys sorted at every depth, so two exports of the same messages read as the same bytes. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** OpenCode, on its own private server rather than any background service, with nothing on its input. */
async function opencode(home: AgentHome, command: [string, string], args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const result = await home.run([...command, "--standalone", ...args], { cwd, timeoutMs: 120_000 });
  return { code: result.code, out: result.stdout.toString("utf8"), err: result.stderr };
}

async function exportOne(home: AgentHome, id: string, cwd: string): Promise<Buffer | null> {
  const { code, out, err } = await opencode(home, ["session", "export"], [id], cwd);
  if (/Session not found/.test(out + err)) return null;
  if (code !== 0) throw new Error(`OpenCode could not export the conversation: ${(err || out).trim().slice(-300)}`);
  return Buffer.from(out);
}

/** Where an import's file waits, inside OpenCode's own data folder at that home. */
const importFolder = (home: AgentHome) => path.posix.join(home.env["XDG_DATA_HOME"] || path.posix.join(home.userHome, ".local", "share"), "openorc-import");

const readVersion = versionReader();

/**
 * OpenCode's sessions, through its own export and import: the root session and its subagents' sessions, parents first.
 * Import re-resolves the project for the folder it is given and keeps the id; a copy already there is deleted and the
 * import repeated, since OpenCode imports no session twice. Never its database.
 */
export const openCodeSlot: SessionSlot & { readonly agent: "opencode" } = {
  agent: "opencode",
  format: 1,
  stays: null,
  version: (home) => readVersion(home),
  readable: (written, reader) => written.split(".")[0] === reader.split(".")[0] && atLeast(reader, written),

  async export(home, ref) {
    const root = await exportOne(home, ref.sessionId, ref.cwd);
    if (!root) return null;
    exported(root, ref.sessionId);
    const parts = [{ name: `${ref.sessionId}.json`, bytes: root }];
    for (const child of ref.children) {
      if (!PART.test(`${child}.json`) || parts.some((part) => part.name === `${child}.json`)) continue;
      const bytes = await exportOne(home, child, ref.cwd);
      if (!bytes) continue;
      exported(bytes, child);
      parts.push({ name: `${child}.json`, bytes });
    }
    return { agent: "opencode", format: 1, cliVersion: null, sessionId: ref.sessionId, parts, meta: {} };
  },

  async import(home, saved, cwd) {
    if (saved.format !== 1) throw new SessionRefused("This OpenCode conversation was saved in a format this version of OpenOrc does not read.");
    if (saved.parts[0]?.name !== `${saved.sessionId}.json`) throw new SessionRefused("The OpenCode conversation does not start with its own session.");
    for (const part of saved.parts) if (!PART.test(part.name)) throw new SessionRefused(`An OpenCode session part has a name it cannot have: ${part.name.slice(0, 100)}`);
    for (const part of saved.parts) exported(part.bytes, part.name.slice(0, -".json".length));
    for (const part of saved.parts) {
      const file = path.posix.join(importFolder(home), `${randomUUID()}-${part.name}`);
      await home.write(file, part.bytes);
      try {
        const id = part.name.slice(0, -".json".length);
        let imported = await opencode(home, ["session", "import"], ["--directory", cwd, file], cwd);
        // OpenCode imports no session twice: the copy here goes first, a root with its children.
        if (/Session already exists/.test(imported.err + imported.out)) {
          await opencode(home, ["session", "delete"], [id], cwd);
          imported = await opencode(home, ["session", "import"], ["--directory", cwd, file], cwd);
        }
        if (imported.code !== 0 || !imported.out.includes(`Imported session: ${id}`))
          throw new Error(`OpenCode could not import the conversation: ${(imported.err || imported.out).trim().slice(-300)}`);
      } finally {
        await home.remove(file);
      }
    }
    return openCodeSlot.digest(saved);
  },

  async check(home, ref) {
    const proc = home.spawn(["acp"], { cwd: ref.cwd });
    const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
    proc.once("error", () => undefined);
    const rpc = new StdioJsonRpc(proc, { includeJsonRpcField: true });
    try {
      await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "openorc", title: "OpenOrc", version: "0.0.0" } }, 30_000);
      const resumed = await rpc.request<{ configOptions?: unknown }>("session/resume", { sessionId: ref.sessionId, cwd: ref.cwd, mcpServers: [] }, 30_000);
      return Array.isArray(resumed.configOptions) ? null : "OpenCode resumed the conversation without its settings.";
    } catch (error) {
      return `OpenCode could not resume this conversation here: ${words(error).slice(0, 300)}`;
    } finally {
      stopProcess(proc);
      await closed;
      await waitForProcessGroup(proc);
    }
  },

  digest(saved: SavedSession) {
    const hash = createHash("sha256");
    for (const part of saved.parts) {
      const id = part.name.slice(0, -".json".length);
      hash.update(`${id}\0${canonical(exported(part.bytes, id).messages)}\0`);
    }
    return hash.digest("hex");
  },

  continueOnce(ref, prompt, settings) {
    const model = settings.model ? ["-m", settings.effort && settings.effort !== "default" ? `${settings.model}#${settings.effort}` : settings.model] : [];
    // OpenCode's run lets its own defaults run commands, so only an autonomous turn approves on its own, and a Plan turn
    // carries OpenOrc's Plan rules, which take every tool that changes anything away.
    const auto = settings.mode === "act" && settings.permissionMode === "autonomous" ? ["--auto"] : [];
    return {
      cmd: "sh",
      args: ["-c", 'exec opencode "$@" < /dev/null', "sh", "run", "--standalone", "--session", ref.sessionId, "--format", "json", ...model, ...auto, prompt],
      parser: (runId) => new OpenCodeRunParser(runId),
      ...(settings.mode === "plan" ? { env: (base: Record<string, string>) => ({ ...base, OPENCODE_CONFIG_CONTENT: planConfig(base["OPENCODE_CONFIG_CONTENT"], undefined) }) } : {}),
    };
  },
};
