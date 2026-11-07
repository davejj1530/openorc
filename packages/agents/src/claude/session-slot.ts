import path from "node:path";
import { SESSION_ID } from "@openorc/protocol";
import { claudePermissionMode } from "./adapter.js";
import { ClaudeStreamParser } from "./stream-json.js";
import { atLeast, partsDigest, SessionRefused, versionReader, type AgentHome, type SessionRef, type SessionSlot } from "../session-slot.js";

const SESSION = "session.jsonl";
/** What travels beside the transcript: the session's subagent and workflow transcripts, from its `<id>/subagents` folder. */
const SUBAGENT_PART = /^subagents\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

/** Where Claude Code keeps a session: `<config>/projects/<the folder it ran in, every other character as ->/<id>.jsonl`. */
export function claudeSessionFile(configDir: string, cwd: string, sessionId: string): string {
  // The id may come from a sandbox's CLI: one that is not a plain name would place the file elsewhere.
  if (!SESSION_ID.test(sessionId)) throw new Error("The conversation's session id is not a plain name.");
  return path.posix.join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
}

/** Every folder a session ran in, as its lines record them. */
function sessionFolders(text: string): string[] {
  const folders = new Set<string>();
  for (const match of text.matchAll(/"cwd":\s*"((?:[^"\\]|\\.)*)"/g)) {
    try {
      const cwd = JSON.parse(`"${match[1]}"`) as string;
      if (cwd.length > 1) folders.add(cwd);
    } catch {
      // Part of a line the CLI was still writing.
    }
  }
  return [...folders];
}

/** The session with every folder it ran in named as `cwd`, so it resumes there as if it had always run there. */
export function sessionMovedTo(text: string, cwd: string): string {
  // Longest first, so a folder inside another is replaced whole.
  return sessionFolders(text)
    .filter((folder) => folder !== cwd)
    .sort((a, b) => b.length - a.length)
    .reduce((moved, folder) => moved.split(folder).join(cwd), text);
}

const configFolder = (home: AgentHome) => home.env["CLAUDE_CONFIG_DIR"] || path.posix.join(home.userHome, ".claude");

/** The transcript at the folder Claude names after `cwd`, else wherever else it ran at this home. */
async function transcriptAt(home: AgentHome, ref: Pick<SessionRef, "sessionId" | "cwd">): Promise<{ file: string; bytes: Buffer } | null> {
  const config = configFolder(home);
  const expected = claudeSessionFile(config, ref.cwd, ref.sessionId);
  const bytes = await home.read(expected);
  if (bytes) return { file: expected, bytes };
  const projects = path.posix.join(config, "projects");
  for (const folder of await home.list(projects)) {
    const file = path.posix.join(projects, folder, `${ref.sessionId}.jsonl`);
    const found = await home.read(file);
    if (found) return { file, bytes: found };
  }
  return null;
}

const readVersion = versionReader();

/** Claude Code's sessions: one transcript per session id, plus its subagents' transcripts in a folder of that name. */
export const claudeSlot: SessionSlot & { readonly agent: "claude" } = {
  agent: "claude",
  format: 1,
  stays: null,
  version: (home) => readVersion(home),
  readable: (written, reader) => atLeast(reader, written),

  async export(home, ref) {
    const transcript = await transcriptAt(home, ref);
    if (!transcript) return null;
    const folder = transcript.file.slice(0, -".jsonl".length);
    const parts = [{ name: SESSION, bytes: transcript.bytes }];
    for (const name of (await home.list(path.posix.join(folder, "subagents"), { recursive: true })).sort())
      parts.push({ name: `subagents/${name}`, bytes: (await home.read(path.posix.join(folder, "subagents", name))) ?? Buffer.alloc(0) });
    return { agent: "claude", format: 1, cliVersion: null, sessionId: ref.sessionId, parts, meta: {} };
  },

  async import(home, saved, cwd) {
    if (saved.format !== 1) throw new SessionRefused("This Claude conversation was saved in a format this version of OpenOrc does not read.");
    for (const part of saved.parts)
      if (part.name !== SESSION && (!SUBAGENT_PART.test(part.name) || part.name.split("/").includes("..")))
        throw new SessionRefused(`A Claude session part has a name it cannot have: ${part.name.slice(0, 100)}`);
    if (!saved.parts.some((part) => part.name === SESSION)) throw new SessionRefused("The Claude conversation has no transcript.");
    const file = claudeSessionFile(configFolder(home), cwd, saved.sessionId);
    const folder = file.slice(0, -".jsonl".length);
    // Claude's lines record the folder each ran in and carry no byte offsets, so naming the new folder is safe.
    const moved = saved.parts.map((part) => ({ name: part.name, bytes: Buffer.from(sessionMovedTo(part.bytes.toString("utf8"), cwd)) }));
    const names = new Set(moved.map((part) => part.name));
    for (const stale of await home.list(path.posix.join(folder, "subagents"), { recursive: true }))
      if (!names.has(`subagents/${stale}`)) await home.remove(path.posix.join(folder, "subagents", stale));
    for (const part of moved) await home.write(part.name === SESSION ? file : path.posix.join(folder, part.name), part.bytes);
    const sorted = [moved.find((part) => part.name === SESSION)!, ...moved.filter((part) => part.name !== SESSION).sort((a, b) => (a.name < b.name ? -1 : 1))];
    return partsDigest(sorted);
  },

  async check(home, ref) {
    const bytes = await home.read(claudeSessionFile(configFolder(home), ref.cwd, ref.sessionId));
    if (!bytes) return "Claude's conversation is not where Claude Code looks for it in this folder.";
    const text = bytes.toString("utf8");
    if (!text.endsWith("\n")) return "Claude's conversation ends partway through a line.";
    if (!text.includes(`"sessionId":"${ref.sessionId}"`)) return "Claude's conversation does not name its own session.";
    return null;
  },

  digest: (saved) => partsDigest(saved.parts),

  continueOnce(ref, prompt, settings) {
    const model = settings.model ? ["--model", settings.model] : [];
    const effort = settings.effort ? ["--effort", settings.effort] : [];
    return {
      cmd: "claude",
      args: ["-p", prompt, "--output-format", "stream-json", "--verbose", "--resume", ref.sessionId, "--permission-mode", claudePermissionMode(settings), ...model, ...effort],
      parser: (runId) => new ClaudeStreamParser(runId),
    };
  },
};
