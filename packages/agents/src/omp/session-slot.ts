import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { StdioJsonRpc } from "../jsonrpc.js";
import { stopProcess, waitForProcessGroup } from "../process-lifetime.js";
import { atLeast, SessionRefused, versionReader, type AgentHome, type SessionSlot } from "../session-slot.js";
import { OmpJsonParser } from "./json-events.js";

/** The one part a saved Oh My Pi conversation has: its own `omp session pack` archive. */
const PART = "session.tar";
const words = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Oh My Pi's folder at a home; PI_CODING_AGENT_DIR moves it. */
const agentDir = (home: AgentHome) => home.env["PI_CODING_AGENT_DIR"] || path.posix.join(home.userHome, ".omp", "agent");
/** Where an archive waits on its way in or out, inside Oh My Pi's own folder at that home. */
const transferFile = (home: AgentHome) => path.posix.join(agentDir(home), "openorc-transfer", `${randomUUID()}.tar`);

/** The archive's entries, each name with its bytes. Plain ustar, as `omp session pack` writes it. */
function entries(tar: Buffer): { name: string; bytes: Buffer }[] {
  const found: { name: string; bytes: Buffer }[] = [];
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0 || at + 512 + size > tar.length) throw new SessionRefused("The Oh My Pi conversation's archive is cut short.");
    found.push({ name, bytes: tar.subarray(at + 512, at + 512 + size) });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return found;
}

/** The archive's manifest, checked to hold the conversation it is said to. */
function manifest(tar: Buffer, id: string): { version: number } {
  const entry = entries(tar).find((candidate) => candidate.name === "manifest.json");
  if (!entry) throw new SessionRefused("The Oh My Pi conversation's archive has no manifest.");
  let parsed: { version?: unknown; id?: unknown };
  try {
    parsed = JSON.parse(entry.bytes.toString("utf8")) as typeof parsed;
  } catch {
    throw new SessionRefused("The Oh My Pi conversation's manifest does not read.");
  }
  if (parsed.id !== id) throw new SessionRefused("Oh My Pi packed another conversation than the one asked for.");
  if (parsed.version !== 1) throw new SessionRefused("This Oh My Pi conversation was packed in a format this version of OpenOrc does not read.");
  return { version: parsed.version };
}

async function pack(home: AgentHome, id: string, cwd: string): Promise<Buffer | null> {
  const file = transferFile(home);
  // Writing the file first makes its folder, with the home's own permissions.
  await home.write(file, Buffer.alloc(0));
  try {
    const { code, stdout, stderr } = await home.run(["session", "pack", id, file], { cwd, timeoutMs: 120_000 });
    if (code !== 0 && /not found/i.test(stderr + stdout.toString("utf8"))) return null;
    if (code !== 0) throw new Error(`Oh My Pi could not pack the conversation: ${(stderr || stdout.toString("utf8")).trim().slice(-300)}`);
    const bytes = await home.read(file);
    if (!bytes?.length) throw new Error("Oh My Pi packed the conversation into nothing.");
    return bytes;
  } finally {
    await home.remove(file);
  }
}

const readVersion = versionReader();

/**
 * Oh My Pi's sessions, through its own `session pack` and `session unpack`: one archive holding the session file with
 * its artifacts and images. Unpacking re-roots it at the folder given and replaces any copy already there, noting in
 * the conversation where it came from. Never its session folder directly.
 */
export const ompSlot: SessionSlot & { readonly agent: "omp" } = {
  agent: "omp",
  format: 1,
  stays: null,
  version: (home) => readVersion(home),
  // The archive's own format is versioned; a newer CLI reads what an older one packed, within one major release.
  readable: (written, reader) => written.split(".")[0] === reader.split(".")[0] && atLeast(reader, written),

  async export(home, ref) {
    const bytes = await pack(home, ref.sessionId, ref.cwd);
    if (!bytes) return null;
    manifest(bytes, ref.sessionId);
    return { agent: "omp", format: 1, cliVersion: null, sessionId: ref.sessionId, parts: [{ name: PART, bytes }], meta: {} };
  },

  async import(home, saved, cwd) {
    if (saved.format !== 1) throw new SessionRefused("This Oh My Pi conversation was saved in a format this version of OpenOrc does not read.");
    const part = saved.parts[0];
    if (saved.parts.length !== 1 || part?.name !== PART) throw new SessionRefused("The Oh My Pi conversation is not one archive.");
    manifest(part.bytes, saved.sessionId);
    const file = transferFile(home);
    await home.write(file, part.bytes);
    try {
      const { code, stdout, stderr } = await home.run(["session", "unpack", file, "--cwd", cwd], { cwd, timeoutMs: 120_000 });
      if (code !== 0) throw new Error(`Oh My Pi could not unpack the conversation: ${(stderr || stdout.toString("utf8")).trim().slice(-300)}`);
    } finally {
      await home.remove(file);
    }
    // Unpacking notes the move in the conversation, so what this home now holds is read back rather than assumed.
    const now = await pack(home, saved.sessionId, cwd);
    if (!now) throw new Error("Oh My Pi unpacked the conversation but cannot find it.");
    return createHash("sha256").update(now).digest("hex");
  },

  async check(home, ref) {
    const proc = home.spawn(["acp"], { cwd: ref.cwd });
    const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
    proc.once("error", () => undefined);
    const rpc = new StdioJsonRpc(proc, { includeJsonRpcField: true });
    try {
      await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "openorc", title: "OpenOrc", version: "0.0.0" } }, 30_000);
      const resumed = await rpc.request<{ configOptions?: unknown }>("session/resume", { sessionId: ref.sessionId, cwd: ref.cwd, mcpServers: [] }, 30_000);
      return Array.isArray(resumed.configOptions) ? null : "Oh My Pi resumed the conversation without its settings.";
    } catch (error) {
      // Resuming read the whole session and stopped only at its model, whose provider signs in when a turn runs here.
      if (/Could not restore model/.test(words(error))) return null;
      return `Oh My Pi could not resume this conversation here: ${words(error).slice(0, 300)}`;
    } finally {
      stopProcess(proc);
      await closed;
      await waitForProcessGroup(proc);
    }
  },

  /** The archive is packed byte for byte the same while the conversation is unchanged. */
  digest(saved) {
    return createHash("sha256")
      .update(saved.parts[0]?.bytes ?? Buffer.alloc(0))
      .digest("hex");
  },

  continueOnce(ref, prompt, settings) {
    const model = settings.model ? ["--model", settings.model] : [];
    const thinking = settings.effort && settings.effort !== "default" ? ["--thinking", settings.effort] : [];
    // Nothing can ask in a headless turn: only an autonomous one runs tools unasked, and Plan stays read-only.
    const approval = settings.mode === "act" && settings.permissionMode === "autonomous" ? "yolo" : "always-ask";
    // Print mode has no one to ask, so what would ask is refused: a turn that is not autonomous only reads.
    return {
      cmd: "sh",
      args: ["-c", 'exec omp "$@" < /dev/null', "sh", "-p", "--mode", "json", "--resume", ref.sessionId, ...model, ...thinking, "--approval-mode", approval, prompt],
      parser: (runId) => new OmpJsonParser(runId),
    };
  },
};
