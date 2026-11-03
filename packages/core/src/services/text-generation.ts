import { settings, type Db } from "@openorc/db";
import { TextGenerator } from "@openorc/memory";
import { HarnessId, harnessCatalog, isHarnessId, type AgentKind, type ModelOption, type RpcParams, type TextGenerationSettings } from "@openorc/protocol";
import type { ProviderInfo } from "./memory.js";
import { z } from "zod";

type Provider = HarnessId;
const KEY = "textGeneration.preferences";
type Preferences = { provider: TextGenerationSettings["provider"]; models: Partial<Record<Provider, string>> };
const preferenceSchema = z.object({ provider: z.enum(["auto", ...HarnessId.options, "off"]), models: z.partialRecord(HarnessId, z.string().min(1)) });

/** Only small models are automatic candidates. Never fall back to the conversation's flagship. */
function defaultModel(provider: Provider, models: ModelOption[]): ModelOption | null {
  if (provider === "claude")
    return (
      models.find((model) => model.id === "claude-haiku-4-5-20251001") ?? {
        id: "claude-haiku-4-5-20251001",
        label: "Claude Haiku 4.5",
        agent: "claude",
        isDefault: false,
        efforts: [],
        defaultEffort: null,
      }
    );
  if (provider === "opencode") {
    const tiers = [/:free$/, /(?:^|[-/])nano(?:-|$)/, /flash-lite/, /(?:^|[-/])mini(?:-|$)/, /haiku/];
    return tiers.flatMap((tier) => models.filter((model) => !model.unavailable && tier.test(model.id)))[0] ?? null;
  }
  return ["nano", "luna", "mini"].flatMap((tier) => models.filter((model) => !model.unavailable && model.id.split("-").includes(tier)))[0] ?? null;
}

type Generator = { generator: TextGenerator; model: { provider: Provider; label: string } } | { reason: string };

/** A one-shot answer from the text-generation model, or why none came. */
export type Completion = { kind: "answered"; text: string; model: { provider: Provider; label: string } } | { kind: "unavailable"; reason: string } | { kind: "failed" };

/** Independent preferences; shares only the CLI runner with memory distillation. */
export class TextGenerationService {
  private pending = 0;
  get hasPendingWork(): boolean {
    return this.pending > 0;
  }
  constructor(
    private readonly db: Db,
    private readonly providers: ProviderInfo,
    private readonly invalidate: (keys: string[]) => void,
  ) {}

  private preferences(): Preferences {
    const raw = settings.get(this.db, KEY);
    try {
      return preferenceSchema.parse(JSON.parse(raw ?? "null"));
    } catch {
      return { provider: "auto", models: {} };
    }
  }

  /**
   * Automatic resolves per conversation, so its settings name no single provider. A chosen
   * harness names every conversation, whichever agent it uses.
   */
  async settings(): Promise<TextGenerationSettings> {
    const prefs = this.preferences();
    if (prefs.provider === "auto" || prefs.provider === "off") return { provider: prefs.provider, model: null, resolved: null, reason: null };
    return { provider: prefs.provider, model: prefs.models[prefs.provider] ?? null, ...(await this.resolve(prefs.provider, prefs.models[prefs.provider] ?? null)) };
  }

  /** The model that names a conversation through `provider`: the chosen one, else a small default. Never the conversation's flagship. */
  private async resolve(provider: Provider, chosen: string | null, claudeAccountId?: string): Promise<Pick<TextGenerationSettings, "resolved" | "reason">> {
    const login = await this.providers.loggedIn(claudeAccountId).catch(() => ({}) as Partial<Record<Provider, boolean>>);
    if (!login[provider] || !this.providers.launch(provider, claudeAccountId)) return { resolved: null, reason: `${harnessCatalog[provider].name} is unavailable. Check its connection in Settings.` };
    const models = await this.providers.models(provider, claudeAccountId).catch(() => []);
    const model = chosen ? { id: chosen, label: models.find((model) => model.id === chosen)?.label ?? chosen } : defaultModel(provider, models);
    if (!model) return { resolved: null, reason: `${harnessCatalog[provider].name} has no small model. Choose a model explicitly.` };
    return { resolved: { provider, model: model.id, label: model.label }, reason: null };
  }

  async updateSettings(patch: RpcParams<"textGeneration.settings.set">): Promise<TextGenerationSettings> {
    const prefs = this.preferences();
    if (patch.provider !== undefined) prefs.provider = patch.provider;
    if (patch.model !== undefined) {
      if (prefs.provider === "auto" || prefs.provider === "off") {
        if (patch.model !== null) throw new Error("Choose a provider before choosing a text-generation model.");
      } else if (patch.model === null) delete prefs.models[prefs.provider];
      else prefs.models[prefs.provider] = patch.model;
    }
    settings.set(this.db, KEY, JSON.stringify(prefs));
    this.invalidate(["text-generation"]);
    return this.settings();
  }

  /** Names a conversation. Automatic uses the conversation's own agent, so its text never reaches another provider. */
  async title(exchange: { request: string; reply: string | null }, agent: AgentKind, claudeAccountId?: string): Promise<string | null> {
    this.pending++;
    try {
      const made = await this.generator(agent, claudeAccountId, { effort: "low", timeoutMs: 30_000 });
      return "generator" in made ? await made.generator.title(exchange) : null;
    } finally {
      this.pending--;
    }
  }

  /** Background text for a conversation, such as an explanation of a file in it, from the model that names it. */
  async complete(request: { prompt: string; schema: object; system: string; agent: AgentKind; claudeAccountId?: string }): Promise<Completion> {
    this.pending++;
    try {
      const made = await this.generator(request.agent, request.claudeAccountId, { system: request.system, timeoutMs: 180_000 });
      if (!("generator" in made)) return { kind: "unavailable", reason: made.reason };
      const text = await made.generator.complete(request.prompt, request.schema);
      return text ? { kind: "answered", text, model: made.model } : { kind: "failed" };
    } finally {
      this.pending--;
    }
  }

  private async generator(agent: AgentKind, claudeAccountId: string | undefined, options: { effort?: "low"; system?: string; timeoutMs: number }): Promise<Generator> {
    const prefs = this.preferences();
    if (prefs.provider === "off") return { reason: "Text generation is off. Turn it on in Settings." };
    const provider = prefs.provider === "auto" ? agent : prefs.provider;
    if (!isHarnessId(provider)) return { reason: "This conversation's agent can't generate text. Choose a harness for text generation in Settings." };
    const { resolved, reason } = await this.resolve(provider, prefs.provider === "auto" ? null : (prefs.models[provider] ?? null), claudeAccountId);
    if (!resolved) return { reason: reason ?? `${harnessCatalog[provider].name} is unavailable. Check its connection in Settings.` };
    const launch = this.providers.launch(resolved.provider, claudeAccountId);
    if (!launch) return { reason: `${harnessCatalog[resolved.provider].name} is unavailable. Check its connection in Settings.` };
    const generator = new TextGenerator({ provider: resolved.provider, model: resolved.model, binary: launch.binary, env: launch.env, ...options });
    return { generator, model: { provider: resolved.provider, label: resolved.label } };
  }
}
