import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { listClaudeSessions, listCodexSessions, readClaudeSession, readCodexSession, type SessionFile } from "@openorc/agents";
import { audit, projects, runs, threads, type Db, type LedgerWriter } from "@openorc/db";
import { isHarnessId, type AgentKind, type HarnessId, type ImportableSession, type Thread } from "@openorc/protocol";

/** Each harness keeps its sessions in its own on-disk format; a harness without a reader cannot be imported yet. */
const sessionReaders: Partial<Record<HarnessId, typeof readClaudeSession>> = { codex: readCodexSession, claude: readClaudeSession };
import type { Logger } from "../transport.js";

/**
 * Sessions the user ran from a terminal become threads: the transcript goes
 * into the ledger as one finished run, and the provider's session id comes
 * along so the next message continues where the terminal left off.
 */
export class ImportService {
  /** Session files already read, by path and modification time, so a second look at the history is instant. */
  private readonly known = new Map<string, { mtimeMs: number; file: SessionFile }>();

  constructor(
    private readonly db: Db,
    private readonly ledger: LedgerWriter,
    private readonly invalidate: (keys: string[]) => void,
    private readonly log: Logger,
  ) {}

  async importable(projectId: string): Promise<ImportableSession[]> {
    const project = projects.get(this.db, projectId);
    if (!project) throw new Error(`project ${projectId} not found`);
    const [claude, codex] = await Promise.all([
      listClaudeSessions(project.rootPath, undefined, (p) => this.cached(p)).catch(() => [] as SessionFile[]),
      listCodexSessions(project.rootPath, undefined, (p) => this.cached(p)).catch(() => [] as SessionFile[]),
    ]);
    const all = [...claude, ...codex];
    for (const s of all) this.known.set(s.path, { mtimeMs: (await stat(s.path).catch(() => ({ mtimeMs: 0 }))).mtimeMs, file: s });
    return all
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((s) => ({ agent: s.agent, path: s.path, sessionId: s.sessionId, title: s.title, messages: s.messages, startedAt: s.startedAt, threadId: this.threadFor(s) }));
  }

  /** A session is already a thread when it was imported before, or when a thread's own run created it. */
  private threadFor(s: SessionFile): string | null {
    const imported = threads.getByImport(this.db, s.path);
    if (imported) return imported.id;
    return runs.threadForSession(this.db, s.sessionId);
  }

  private async cached(file: string): Promise<SessionFile | null | undefined> {
    const hit = this.known.get(file);
    if (!hit) return undefined;
    const s = await stat(file).catch(() => null);
    return s && s.mtimeMs === hit.mtimeMs ? hit.file : undefined;
  }

  async import(projectId: string, sessions: { agent: AgentKind; path: string }[]): Promise<Thread[]> {
    const project = projects.get(this.db, projectId);
    if (!project) throw new Error(`project ${projectId} not found`);
    const out: Thread[] = [];
    for (const s of sessions) {
      const existing = threads.getByImport(this.db, s.path);
      if (existing) {
        out.push(existing);
        continue;
      }
      const runId = randomUUID();
      const read = isHarnessId(s.agent) ? ((await sessionReaders[s.agent]?.(s.path, runId, project.rootPath)) ?? null) : null;
      if (!read) {
        this.log.warn(`could not read ${s.agent} session at ${s.path}`);
        continue;
      }
      const thread = threads.insert(this.db, {
        projectId,
        title: read.title,
        agent: read.agent,
        model: null,
        mode: "act",
        permissionMode: "trusted",
        workspaceMode: "current",
        importedFrom: s.path,
        createdAt: read.startedAt,
      });
      runs.insert(this.db, { id: runId, taskId: null, threadId: thread.id, agent: read.agent, model: null, mode: "act", permissionMode: "trusted" });
      runs.update(this.db, runId, { state: "success", externalSessionId: read.sessionId, endedAt: read.endedAt, resultText: read.lastReply });
      for (const ev of read.events) this.ledger.push(ev);
      this.ledger.flush();
      this.db.stmt("UPDATE threads SET last_activity_at = ?, seen_at = ?, updated_at = ? WHERE id = ?").run(read.endedAt, read.endedAt, read.endedAt, thread.id);
      audit.record(this.db, { actor: "user", action: "thread.import", resourceType: "thread", resourceId: thread.id, metadata: { agent: read.agent, path: s.path, messages: read.messages } });
      out.push(threads.get(this.db, thread.id) as Thread);
    }
    this.invalidate(["threads"]);
    return out;
  }
}
