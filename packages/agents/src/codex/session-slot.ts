import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { StdioJsonRpc } from "../jsonrpc.js";
import { stopProcess, waitForProcessGroup } from "../process-lifetime.js";
import { CodexExecParser } from "./exec-json.js";
import { atLeast, partsDigest, SessionRefused, versionReader, type AgentHome, type RunSettings, type SessionSlot } from "../session-slot.js";

/** Where Codex keeps a rollout, relative to its folder: by date under sessions, or archived. */
const ROLLOUT = /^(?:sessions\/\d{4}\/\d{2}\/\d{2}|archived_sessions(?:\/\d{4}\/\d{2}\/\d{2})?)\/rollout-[A-Za-z0-9_.:-]+\.jsonl(?:\.zst)?$/;
const HISTORY_MODES = new Set([undefined, "legacy", "paginated"]);
/** Where proving a resume points the thread's provider: nothing answers there, so no model or sign-in is reached. */
const NOWHERE = '"http://127.0.0.1:9/v1"';
/**
 * Codex resumes a thread only with the provider it recorded as the current one, so the check selects that provider and
 * moves its address. The built-in OpenAI provider takes its address from its own key; one of the person's, from its table.
 */
function offline(provider: string): string[] {
  if (!/^[A-Za-z0-9_-]+$/.test(provider)) return [];
  const address = provider === "openai" ? `openai_base_url=${NOWHERE}` : `model_providers.${provider}.base_url=${NOWHERE}`;
  return ["-c", `model_provider="${provider}"`, "-c", address];
}

/** How codex exec's sandbox stands in for the conversation's permissions: nothing can ask, so review only reads. */
const execPermission: Record<RunSettings["permissionMode"], string[]> = {
  review: ["-c", 'sandbox_mode="read-only"'],
  trusted: ["-c", 'sandbox_mode="workspace-write"'],
  autonomous: ["--dangerously-bypass-approvals-and-sandbox"],
};

/** A resume starts the MCP servers the home's config names; a check switches each off, since it has no use for them. */
async function withoutMcpServers(home: AgentHome): Promise<string[]> {
  const config = (await home.read(path.posix.join(folder(home), "config.toml")))?.toString("utf8") ?? "";
  const names = new Set([...config.matchAll(/^\s*\[mcp_servers\.(?:"([A-Za-z0-9_-]+)"|([A-Za-z0-9_-]+))\]/gm)].map((match) => match[1] ?? match[2]));
  return [...names].flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]);
}

const folder = (home: AgentHome) => home.env["CODEX_HOME"] || path.posix.join(home.userHome, ".codex");
const words = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Every rollout at a home, newest dated first, archived last; finds one by the id its file name ends with. */
async function rollouts(home: AgentHome): Promise<(id: string) => string | null> {
  const listed = async (dir: string) => (await home.list(path.posix.join(folder(home), dir), { recursive: true })).map((file) => `${dir}/${file}`).filter((file) => ROLLOUT.test(file));
  const names = [...(await listed("sessions")).sort().reverse(), ...(await listed("archived_sessions")).sort().reverse()];
  return (id) => names.find((name) => name.endsWith(`-${id}.jsonl`) || name.endsWith(`-${id}.jsonl.zst`)) ?? null;
}

/** The rollout's first record, which names the rollout it builds on; refuses one this slot does not know how to follow. */
function sessionMeta(name: string, bytes: Buffer): { base: string | null; provider: string } {
  let text: string;
  try {
    text = (name.endsWith(".zst") ? zstdDecompressSync(bytes) : bytes).toString("utf8");
  } catch {
    throw new SessionRefused("A compressed part of this Codex conversation could not be read.");
  }
  let first: { type?: unknown; payload?: { history_mode?: unknown; model_provider?: unknown; history_base?: { thread_id?: unknown } } };
  try {
    const end = text.indexOf("\n");
    first = JSON.parse(end < 0 ? text : text.slice(0, end)) as typeof first;
  } catch {
    throw new SessionRefused("A part of this Codex conversation does not start with its session record.");
  }
  if (first.type !== "session_meta") throw new SessionRefused("A part of this Codex conversation does not start with its session record.");
  if (!HISTORY_MODES.has(first.payload?.history_mode as string | undefined))
    throw new SessionRefused(`This Codex conversation keeps its history in a way this version of OpenOrc does not know: ${String(first.payload?.history_mode).slice(0, 40)}.`);
  const base = first.payload?.history_base?.thread_id;
  const provider = first.payload?.model_provider;
  return { base: typeof base === "string" ? base : null, provider: typeof provider === "string" ? provider : "openai" };
}

const readVersion = versionReader();

/**
 * Codex's sessions: the rollout named by the thread's id, every rollout its history builds on, and its subagents'
 * rollouts, as exact bytes at the same names. Never parsed past the first record or rewritten: a paginated fork
 * records byte offsets into the rollout it builds on.
 */
export const codexSlot: SessionSlot & { readonly agent: "codex" } = {
  agent: "codex",
  format: 1,
  stays: null,
  version: (home) => readVersion(home),
  readable: (written, reader) => written.split(".")[0] === reader.split(".")[0] && atLeast(reader, written),

  async export(home, ref) {
    const find = await rollouts(home);
    const selected = find(ref.sessionId);
    if (!selected) return null;
    const parts: { name: string; bytes: Buffer }[] = [];
    const add = async (name: string) => {
      if (parts.some((part) => part.name === name)) return;
      const bytes = await home.read(path.posix.join(folder(home), name));
      if (!bytes) throw new SessionRefused("A part of this Codex conversation went missing while it was read.");
      parts.push({ name, bytes });
      const { base } = sessionMeta(name, bytes);
      if (!base) return;
      const dependency = find(base);
      if (!dependency) throw new SessionRefused("This Codex conversation builds on an earlier one that is not on this machine, so it cannot move.");
      await add(dependency);
    };
    await add(selected);
    for (const child of ref.children) {
      const name = find(child);
      if (name) await add(name);
    }
    return { agent: "codex", format: 1, cliVersion: null, sessionId: ref.sessionId, parts, meta: { selected } };
  },

  async import(home, saved) {
    if (saved.format !== 1) throw new SessionRefused("This Codex conversation was saved in a format this version of OpenOrc does not read.");
    for (const part of saved.parts) if (!ROLLOUT.test(part.name)) throw new SessionRefused(`A Codex session part has a name it cannot have: ${part.name.slice(0, 100)}`);
    if (!saved.parts.some((part) => part.name === saved.meta["selected"])) throw new SessionRefused("The Codex conversation does not include the rollout it names.");
    for (const part of saved.parts) await home.write(path.posix.join(folder(home), part.name), part.bytes);
    return partsDigest(saved.parts);
  },

  async check(home, ref) {
    const selected = (await rollouts(home))(ref.sessionId);
    const bytes = selected ? await home.read(path.posix.join(folder(home), selected)) : null;
    if (!selected || !bytes) return "Codex's conversation is not in its sessions folder here.";
    const args = ["app-server", "--listen", "stdio://", ...offline(sessionMeta(selected, bytes).provider), ...(await withoutMcpServers(home))];
    const proc = home.spawn(args, { cwd: ref.cwd });
    const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
    proc.once("error", () => undefined);
    const rpc = new StdioJsonRpc(proc);
    try {
      await rpc.request("initialize", { clientInfo: { name: "openorc", title: "OpenOrc", version: "0.0.0" }, capabilities: { experimentalApi: true } }, 15_000);
      rpc.notify("initialized", {});
      const resumed = await rpc.request<{ thread?: { id?: unknown } }>(
        "thread/resume",
        { threadId: ref.sessionId, path: path.posix.join(folder(home), selected), cwd: ref.cwd, excludeTurns: true },
        30_000,
      );
      return resumed.thread?.id === ref.sessionId ? null : "Codex resumed another conversation than this one.";
    } catch (error) {
      return `Codex could not resume this conversation here: ${words(error).slice(0, 300)}`;
    } finally {
      stopProcess(proc);
      await closed;
      await waitForProcessGroup(proc);
    }
  },

  digest: (saved) => partsDigest(saved.parts),

  continueOnce(ref, prompt, settings) {
    const permission = settings.mode === "plan" ? execPermission.review : execPermission[settings.permissionMode];
    const model = settings.model ? ["-m", settings.model] : [];
    const effort = settings.effort ? ["-c", `model_reasoning_effort="${settings.effort}"`] : [];
    return { cmd: "codex", args: ["exec", "resume", "--json", ...permission, ...model, ...effort, ref.sessionId, prompt], parser: (runId) => new CodexExecParser(runId) };
  },
};
