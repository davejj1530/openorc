import { extractionJobs, listEvents, memories, settings, summaries, tasks, vectors, type Db, type MemoryFilter, type MemoryInput } from "@openorc/db";
import type { AgentLaunchEnvironment } from "@openorc/agents";
import { buildBrief, buildOrclingBrief, DIGEST_EVENT_KINDS, digestRun, Embedder, Extractor, hasBrief, Retriever, type RetrievedMemory, type TextEmbedder } from "@openorc/memory";
import {
  distillationHarnessIds,
  harnessCatalog,
  harnessNameList,
  isHarnessId,
  type AgentEvent,
  type AgentKind,
  type ExtractionProviderChoice,
  type HarnessId,
  type Memory,
  type MemorySettings,
  type MemoryType,
  type ModelOption,
  type Project,
  type ResolvedExtraction,
  type Run,
  type SessionSummary,
  type Task,
  type Thread,
} from "@openorc/protocol";
import { ExtractionCredentials, type ExtractionCredential, type ProtectedSecretStore } from "./extraction-credentials.js";
import type { Logger } from "../transport.js";

export interface MemoryServiceOptions {
  dataDir: string;
  secrets?: ProtectedSecretStore;
  /** Where the embedding model runs. Defaults to this thread. */
  embedder?: TextEmbedder;
}

/** What the run layer knows about the user's agents; resolved lazily so construction order is free. */
export interface ProviderInfo {
  models(agent: AgentKind): Promise<ModelOption[]>;
  loggedIn(): Promise<Record<HarnessId, boolean>>;
  /** The binary and complete environment from one atomic shell snapshot. */
  launch(agent: HarnessId): AgentLaunchEnvironment | null;
}

const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";
/** Each distillation starts a provider process; more at once only competes with the user's own agents. */
const MAX_CONCURRENT_EXTRACTIONS = 2;
/** The most events one distillation reads; a longer run keeps its newest. */
const EXTRACTION_EVENT_LIMIT = 5000;

/** A run too long to read whole keeps its newest events, which can leave out what it was started for: its first request. */
function openingRequest(db: Db, runId: string, newest: AgentEvent[]): AgentEvent[] {
  const first = listEvents(db, runId, { kinds: ["message.completed"], limit: 50 }).find((ev) => ev.type === "message.completed" && ev.role === "user");
  if (first?.type !== "message.completed") return [];
  return newest.some((ev) => ev.type === "message.completed" && ev.messageId === first.messageId) ? [] : [first];
}
interface ExtractionResolution {
  resolved: ResolvedExtraction | null;
  reason: string | null;
}

/**
 * Owns the memory lifecycle: distilling finished runs into typed memories in
 * the background, serving retrieval and the per-project brief, and answering
 * the MCP memory tools. Every path degrades safely: no embeddings means
 * full-text retrieval, no Claude CLI means no extraction, never a thrown error
 * into a run.
 */
export class MemoryService {
  private readonly embedder: TextEmbedder;
  private readonly retriever: Retriever;
  private extracting = 0;
  /** Finished runs waiting for a distillation slot, by run id. */
  private readonly queuedExtractions = new Map<string, () => Promise<void>>();
  private readonly credentials: ExtractionCredentials;
  private configuration: Promise<unknown> = Promise.resolve();
  private policyRevision = 0;
  private closing = false;
  private readonly background = new Set<Promise<unknown>>();
  private configuring = 0;
  /** Which Orcling a finished run's memories belong to: set for an Orcling's own conversation, null for a project's. */
  extractionOwner: (run: Run, thread: Thread | null) => string | null = () => null;

  constructor(
    private readonly db: Db,
    options: MemoryServiceOptions,
    private readonly providers: ProviderInfo,
    private readonly invalidate: (keys: string[]) => void,
    private readonly log: Logger,
  ) {
    // Memory is opt-in: a profile that never saved the switch stays off until the user turns it on.
    this.credentials = new ExtractionCredentials(options.secrets);
    this.embedder = options.embedder ?? new Embedder(options.dataDir);
    this.retriever = new Retriever(db, this.embedder);
  }

  /* Extraction settings */

  enabled(): boolean {
    return !this.closing && settings.get(this.db, "memory.enabled") === "true";
  }

  get hasPendingWork(): boolean {
    return this.background.size > 0 || this.configuring > 0 || this.queuedExtractions.size > 0;
  }

  /** Fence new work and drain admitted memory operations before core closes SQLite. */
  async shutdown(): Promise<void> {
    this.closing = true;
    this.queuedExtractions.clear();
    // A long embed ends at its next batch; the vectors it skips are backfilled at the next start.
    const released = this.embedder.close?.();
    await this.configuration;
    await Promise.allSettled([...this.background]);
    await released;
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.background.add(operation);
    void operation.then(
      () => this.background.delete(operation),
      (error: unknown) => {
        this.background.delete(operation);
        this.log.warn(`memory background work failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
    return operation;
  }

  assertEnabled(): void {
    if (!this.enabled()) throw new Error("OpenOrc memory is off. Enable it in Memory settings to save or recall memories.");
  }

  private configure<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Memory is shutting down."));
    this.configuring += 1;
    const next = this.configuration.then(operation, operation).finally(() => {
      this.configuring -= 1;
    });
    this.configuration = next.catch(() => {});
    return next;
  }

  private providerChoice(): ExtractionProviderChoice {
    return (settings.get(this.db, "extraction.provider") as ExtractionProviderChoice | null) ?? "auto";
  }

  private chosenModel(provider: HarnessId): string | null {
    return settings.get(this.db, `extraction.model.${provider}`);
  }

  /** Cheapest sensible model per provider: Haiku for Claude, a small Codex model if the account lists one. */
  private async defaultModel(provider: HarnessId): Promise<ModelOption | null> {
    const list = await this.providers.models(provider).catch(() => [] as ModelOption[]);
    if (provider === "claude")
      return list.find((m) => m.id === DEFAULT_CLAUDE_MODEL) ?? { id: DEFAULT_CLAUDE_MODEL, label: "Claude Haiku 4.5", agent: "claude", isDefault: false, efforts: [], defaultEffort: null };
    return list.find((m) => /spark|mini|nano/i.test(m.id)) ?? list.find((m) => m.isDefault) ?? list[0] ?? null;
  }

  private loggedIn(): Promise<Partial<Record<HarnessId, boolean>>> {
    return this.providers.loggedIn().catch((): Partial<Record<HarnessId, boolean>> => ({}));
  }

  /** The model a provider distils with: the user's choice for that provider, else its cheapest sensible default. */
  private async modelFor(provider: HarnessId, viaApiKey: boolean): Promise<ExtractionResolution> {
    const chosen = this.chosenModel(provider);
    const list = await this.providers.models(provider).catch(() => [] as ModelOption[]);
    const option =
      (chosen ? (list.find((m) => m.id === chosen) ?? { id: chosen, label: chosen, agent: provider, isDefault: false, efforts: [], defaultEffort: null }) : null) ??
      (await this.defaultModel(provider));
    if (!option) return { resolved: null, reason: "No model is available for distillation." };
    return { resolved: { provider, model: option.id, label: option.label, viaApiKey }, reason: null };
  }

  /**
   * The provider and model that summarize a run of `agent`, or null with the reason nothing runs.
   * Automatic keeps a run with the provider that ran it, so its content only reaches another
   * provider when the user chose that provider for every run.
   */
  private async resolveExtraction(credential: ExtractionCredential, agent: AgentKind): Promise<ExtractionResolution> {
    const choice = this.providerChoice();
    if (!this.enabled() || choice === "off") return { resolved: null, reason: null };
    if (choice === "apikey")
      // An Anthropic API key runs through Claude Code.
      return credential.apiKey ? this.modelFor("claude", true) : { resolved: null, reason: credential.error ?? "Add an Anthropic API key, or pick another provider." };
    const provider = choice === "auto" ? agent : choice;
    const name = isHarnessId(provider) ? harnessCatalog[provider].name : provider;
    if (!isHarnessId(provider) || !harnessCatalog[provider].distillation)
      return { resolved: null, reason: choice === "auto" ? `${name} runs are not summarized automatically. Choose a provider to include them.` : `${name} cannot distil memory yet.` };
    if (!(await this.loggedIn())[provider]) return { resolved: null, reason: `${name} is not logged in.` };
    return this.modelFor(provider, false);
  }

  /** What Automatic uses for each signed-in agent that can summarize its own runs. */
  private async automaticExtraction(): Promise<ResolvedExtraction[]> {
    if (!this.enabled() || this.providerChoice() !== "auto") return [];
    const login = await this.loggedIn();
    const resolutions = await Promise.all(distillationHarnessIds.filter((id) => login[id]).map((id) => this.modelFor(id, false)));
    return resolutions.flatMap(({ resolved }) => (resolved ? [resolved] : []));
  }

  credentialStatus(): Promise<Pick<MemorySettings, "hasApiKey" | "apiKeyError">> {
    return this.configure(async () => {
      const credential = await this.credentials.read();
      return { hasApiKey: Boolean(credential.apiKey), ...(credential.error ? { apiKeyError: credential.error } : {}) };
    });
  }

  settings(): Promise<MemorySettings> {
    return this.configure(() => this.readSettings());
  }

  private async readSettings(): Promise<MemorySettings> {
    const credential = await this.credentials.read();
    const provider = this.providerChoice();
    const target = this.modelTarget(provider);
    const automatic = await this.automaticExtraction();
    const { resolved, reason } =
      provider === "auto"
        ? {
            resolved: null,
            reason: this.enabled() && automatic.length === 0 ? `Log in to ${harnessNameList(distillationHarnessIds)}. Automatic summarizes each run with the agent that ran it.` : null,
          }
        : await this.resolveExtraction(credential, target ?? "claude");
    return {
      enabled: this.enabled(),
      provider,
      model: target ? this.chosenModel(target) : null,
      hasApiKey: Boolean(credential.apiKey),
      ...(credential.error ? { apiKeyError: credential.error } : {}),
      resolved,
      automatic,
      reason,
    };
  }

  /** The provider whose model choice a setting applies to. An Anthropic API key runs through Claude Code. Automatic uses each provider's default. */
  private modelTarget(choice: ExtractionProviderChoice): HarnessId | null {
    return extractionHarness(choice);
  }

  updateSettings(patch: { enabled?: boolean; provider?: ExtractionProviderChoice; model?: string | null; apiKey?: string }): Promise<MemorySettings> {
    return this.configure(async () => {
      // Protect the credential before committing the provider/model part of a patch.
      if (patch.apiKey !== undefined) await this.credentials.write(patch.apiKey);
      if (patch.enabled === false || patch.provider === "off") this.policyRevision += 1;
      if (patch.enabled !== undefined) settings.set(this.db, "memory.enabled", String(patch.enabled));
      if (patch.provider) settings.set(this.db, "extraction.provider", patch.provider);
      if (patch.model !== undefined) {
        const target = this.modelTarget(this.providerChoice());
        if (!target) {
          if (patch.model !== null) throw new Error("Choose a provider before choosing a model.");
        } else if (patch.model) settings.set(this.db, `extraction.model.${target}`, patch.model);
        else settings.remove(this.db, `extraction.model.${target}`);
      }
      this.invalidate(["settings"]);
      return this.readSettings();
    });
  }

  /** The extractor for a run of `agent`. Null when none is available or distillation is off. */
  extractor(agent: AgentKind): Promise<Extractor | null> {
    return this.configure(async () => {
      if (!this.extractionEnabled()) return null;
      const credential = await this.credentials.read();
      const { resolved } = await this.resolveExtraction(credential, agent);
      if (!resolved) return null;
      const launch = this.providers.launch(resolved.provider);
      if (!launch) return null;
      return new Extractor({
        provider: resolved.provider,
        model: resolved.model,
        binary: launch.binary,
        env: launch.env,
        ...(resolved.viaApiKey && credential.apiKey ? { apiKey: credential.apiKey } : {}),
      });
    });
  }

  extractionEnabled(): boolean {
    return this.enabled() && this.providerChoice() !== "off";
  }

  /** The system-prompt brief for a run, or "" when the project has no memory yet. */
  brief(project: Project): string {
    if (!this.enabled() || !hasBrief(this.db, project.id)) return "";
    const openTitles = tasks
      .list(this.db, { projectId: project.id, statuses: ["in_progress", "review"] })
      .map((t) => t.title)
      .slice(0, 8);
    return buildBrief(this.db, project.id, openTitles);
  }

  /**
   * Distill a finished run. Fire-and-forget: queued, run off the request path,
   * and guarded so a failure only marks the job, never disturbs the app.
   */
  onRunFinished(run: Run, scope: { task: Task | null; thread: Thread | null }, project: Project): void {
    if (!this.extractionEnabled()) return;
    if (extractionJobs.get(this.db, run.id)?.state === "done") return;
    // The policy in force when the run finished decides, however long it waits for a slot.
    const revision = this.policyRevision;
    this.queuedExtractions.set(run.id, () => this.runExtraction(run, scope, project, revision));
    this.drainExtractions();
  }

  /** Starts queued distillations while fewer than MAX_CONCURRENT_EXTRACTIONS run. Nothing new starts once closing. */
  private drainExtractions(): void {
    for (const [runId, extraction] of this.queuedExtractions) {
      if (this.closing || this.extracting >= MAX_CONCURRENT_EXTRACTIONS) return;
      this.queuedExtractions.delete(runId);
      this.extracting += 1;
      void this.track(
        extraction().finally(() => {
          this.extracting -= 1;
          this.drainExtractions();
        }),
      );
    }
  }

  private async runExtraction(run: Run, scope: { task: Task | null; thread: Thread | null }, project: Project, revision: number): Promise<void> {
    const permitted = () => this.extractionEnabled() && revision === this.policyRevision;
    const title = scope.task?.title ?? scope.thread?.title ?? "conversation";
    const spec = scope.task?.spec ?? null;
    extractionJobs.start(this.db, run.id);
    try {
      if (!permitted()) {
        extractionJobs.finish(this.db, run.id, { state: "skipped", error: "memory learning was disabled" });
        return;
      }
      const events = listEvents(this.db, run.id, { kinds: DIGEST_EVENT_KINDS, newest: true, limit: EXTRACTION_EVENT_LIMIT });
      const digest = digestRun(events.length === EXTRACTION_EVENT_LIMIT ? [...openingRequest(this.db, run.id, events), ...events] : events);
      if (digest.prompts.length === 0 && digest.toolLines.length === 0) {
        extractionJobs.finish(this.db, run.id, { state: "skipped" });
        return;
      }
      const extractor = await this.extractor(run.agent);
      if (!extractor || !permitted()) {
        extractionJobs.finish(this.db, run.id, { state: "skipped", error: "no distillation provider available" });
        return;
      }
      const orclingId = this.extractionOwner(run, scope.thread);
      const result = await extractor.extract(digest, { taskTitle: title, taskSpec: spec, orcling: orclingId !== null });
      if (!permitted()) {
        extractionJobs.finish(this.db, run.id, { state: "skipped", error: "memory learning was disabled" });
        return;
      }
      if (!result) {
        extractionJobs.finish(this.db, run.id, { state: "skipped", error: "extractor unavailable or unparseable" });
        return;
      }
      const learned = this.leaveUserTopics(project.id, result.memories, orclingId);
      const written = this.db.transaction(() => {
        summaries.upsert(this.db, {
          runId: run.id,
          taskId: scope.task?.id ?? null,
          threadId: scope.thread?.id ?? null,
          projectId: project.id,
          request: result.summary.request || title,
          workDone: result.summary.workDone,
          outcome: result.summary.outcome,
          openItems: result.summary.openItems,
          model: run.model,
        });
        return learned.map((mem) => {
          const input: MemoryInput = {
            projectId: project.id,
            orclingId,
            type: mem.type,
            topicKey: mem.topicKey,
            title: mem.title,
            body: mem.body,
            confidence: mem.confidence,
            source: "extraction",
            sourceRunId: run.id,
            sourceTaskId: scope.task?.id ?? null,
            files: mem.files,
          };
          const { memory } = memories.upsert(this.db, input);
          return memory;
        });
      });
      extractionJobs.finish(this.db, run.id, { state: "done", memoriesWritten: written.length });
      this.log.info(`extracted ${written.length} mem` + `ory item(s) from run ${run.id}; left ${result.memories.length - learned.length} topic(s) the user wrote unchanged`);
      this.invalidate([...memoryKeys({ projectId: project.id, orclingId }), ...(scope.task ? [`memory:task:${scope.task.id}`] : [])]);
      void this.track(this.embedAll(written, permitted));
    } catch (e) {
      extractionJobs.finish(this.db, run.id, { state: "failed", error: e instanceof Error ? e.message : String(e) });
      this.log.warn(`extraction failed for run ${run.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** A topic the user wrote stays theirs. Extraction leaves it alone rather than failing and losing the run's summary. */
  private leaveUserTopics<T extends { topicKey?: string | null }>(projectId: string, learned: T[], orclingId: string | null): T[] {
    return learned.filter((mem) => !mem.topicKey || !memories.userOwnsTopic(this.db, projectId, mem.topicKey, orclingId));
  }

  /** Embeds distilled memories outside the distillation slot, so a model still downloading holds up no other run. */
  private async embedAll(written: Memory[], permitted: () => boolean): Promise<void> {
    for (const memory of written) {
      if (!permitted()) return;
      await this.embed(memory);
    }
  }

  private async embed(memory: Memory): Promise<void> {
    if (!this.enabled()) return;
    const revision = this.policyRevision;
    try {
      const vec = await this.embedder.embed([`${memory.title}\n${memory.body}`]);
      if (this.enabled() && revision === this.policyRevision && vec && vec[0] && memories.get(this.db, memory.id)) vectors.put(this.db, memory.id, vec[0]);
    } catch (e) {
      this.log.warn(`embedding failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Backfill vectors for memories that predate embeddings. Runs once at startup. */
  backfillVectors(): Promise<void> {
    return this.track(this.backfill());
  }

  private async backfill(): Promise<void> {
    if (!this.enabled()) return;
    const revision = this.policyRevision;
    const pending = vectors.missing(this.db, 500);
    if (pending.length === 0) return;
    const vecs = await this.embedder.embed(pending.map((m) => `${m.title}\n${m.body}`)).catch(() => null);
    if (!vecs || !this.enabled() || revision !== this.policyRevision) return;
    pending.forEach((m, i) => {
      const v = vecs[i];
      if (v) vectors.put(this.db, m.id, v);
    });
    this.log.info(`backfilled ${pending.length} memory vector(s)`);
  }

  /* MCP and RPC surface */

  async retrieve(projectId: string | null, query: string, limit: number, types?: MemoryType[]): Promise<RetrievedMemory[]> {
    if (!this.enabled()) return [];
    const revision = this.policyRevision;
    const results = await this.searchSaved(projectId, query, limit, types);
    return this.enabled() && revision === this.policyRevision ? results : [];
  }

  /** User-facing browsing remains available while agent recall is disabled, by words alone so the model is not downloaded. */
  searchSaved(projectId: string | null, query: string, limit: number, types?: MemoryType[]): Promise<RetrievedMemory[]> {
    if (this.closing) return Promise.resolve([]);
    return this.track(this.retriever.retrieve({ projectId, query, limit, semantic: this.enabled(), ...(types ? { types } : {}) }));
  }

  list(projectId: string, options: Omit<MemoryFilter, "projectId"> = {}): Memory[] {
    return memories.list(this.db, { projectId, ...options });
  }

  /** An Orcling's own memories, which no project search sees. */
  listOrcling(orclingId: string, options: Omit<MemoryFilter, "projectId" | "orclingId"> = {}): Memory[] {
    return memories.list(this.db, { orclingId, ...options });
  }

  async retrieveOrcling(orclingId: string, query: string, limit: number): Promise<RetrievedMemory[]> {
    if (!this.enabled() || this.closing) return [];
    const revision = this.policyRevision;
    const results = await this.track(this.retriever.retrieve({ projectId: null, orclingId, query, limit, semantic: true }));
    return this.enabled() && revision === this.policyRevision ? results : [];
  }

  /** What an Orcling remembers, for its prompt; empty while memory is off. */
  orclingBrief(orclingId: string): string {
    return this.enabled() ? buildOrclingBrief(this.db, orclingId) : "";
  }

  record(input: MemoryInput): Memory {
    this.assertEnabled();
    const { memory } = memories.upsert(this.db, input);
    void this.track(this.embed(memory));
    this.invalidate(memoryKeys(memory));
    return memory;
  }

  update(id: string, patch: Parameters<typeof memories.update>[2]): Memory {
    const m = memories.update(this.db, id, patch);
    if (patch.title || patch.body) void this.track(this.embed(m));
    this.invalidate(memoryKeys(m));
    return m;
  }

  feedback(id: string, verdict: "helpful" | "wrong" | "stale"): Memory {
    const m = memories.feedback(this.db, id, verdict);
    this.invalidate(memoryKeys(m));
    return m;
  }

  remove(id: string): void {
    const m = memories.get(this.db, id);
    memories.remove(this.db, id);
    this.invalidate(memoryKeys(m ?? { projectId: null }));
  }

  recentSummaries(projectId: string, limit = 5): SessionSummary[] {
    return summaries.recent(this.db, projectId, limit);
  }

  summariesForTask(taskId: string): SessionSummary[] {
    return summaries.forTask(this.db, taskId);
  }

  /** Context for a task: its spec, prior run summaries, and the most relevant memories. */
  async taskContext(task: Task): Promise<string> {
    const lines: string[] = [`Task: ${task.title}`, task.spec ? `Spec: ${task.spec}` : "Spec: (none)", `Status: ${task.status}`];
    const taskOnly = lines.join("\n");
    if (!this.enabled()) return taskOnly;
    const revision = this.policyRevision;
    const priors = summaries.forTask(this.db, task.id);
    if (priors.length > 0) {
      lines.push("", "Earlier runs on this task:");
      for (const s of priors.slice(-4)) lines.push(`- ${s.outcome}: ${s.workDone}${s.openItems.length ? ` (open: ${s.openItems.join("; ")})` : ""}`);
    }
    const query = [task.title, task.spec ?? ""].join(" ");
    const relevant = await this.retrieve(task.projectId, query, 8).catch(() => []);
    if (relevant.length > 0) {
      lines.push("", "Relevant memory:");
      for (const { memory } of relevant) lines.push(`- [${memory.type}] ${memory.title}: ${memory.body}`);
    }
    return this.enabled() && revision === this.policyRevision ? lines.join("\n") : taskOnly;
  }
}

/** Cache keys for a memory's list: its project's, or its Orcling's. */
function memoryKeys(owner: { projectId: string | null; orclingId?: string | null }): string[] {
  return ["memory", owner.orclingId ? `memory:orcling:${owner.orclingId}` : `memory:${owner.projectId ?? ""}`];
}

function extractionHarness(choice: string) {
  if (choice === "apikey") return "claude";
  if (isHarnessId(choice)) return choice;
  return null;
}
