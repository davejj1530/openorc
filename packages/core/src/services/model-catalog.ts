import type { Db } from "@openorc/db";
import { AgentKind, HarnessId, type ModelCatalogProvider, type ModelOption } from "@openorc/protocol";
import { z } from "zod";
import { keptAnswers, type Kept } from "./kept-answers.js";

export interface DiscoveredModels {
  models: ModelOption[];
  message?: string;
}
export interface CatalogEntry extends DiscoveredModels {
  provider: ModelCatalogProvider;
}

const KeptCatalog: z.ZodType<CatalogEntry> = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      agent: AgentKind,
      isDefault: z.boolean(),
      efforts: z.array(z.string()),
      defaultEffort: z.string().nullable(),
      provider: z.object({ id: z.string(), label: z.string() }).optional(),
      fastMode: z.object({ supported: z.boolean(), reason: z.string().optional() }).optional(),
      unavailable: z.string().optional(),
      legacy: z.boolean().optional(),
    }),
  ),
  message: z.string().optional(),
  provider: z.object({ agent: HarnessId, status: z.enum(["ready", "fallback", "stale", "error"]), refreshedAt: z.number().nullable(), message: z.string().nullable() }),
});

/** Each agent's last model list, by agent and the account it was listed on. */
export const keptCatalogs = (db: Db): Kept<CatalogEntry> => keptAnswers(db, "models.last", KeptCatalog);
interface Cached {
  revision: number;
  entry?: CatalogEntry;
  checkedAt?: number;
  pending?: Promise<CatalogEntry>;
  /** What an earlier environment or run of the app listed. */
  earlier?: CatalogEntry;
  keptAs?: string;
}
interface Options {
  now?: () => number;
  ttl?: number;
  /** Where a list outlives the app. */
  kept?: Kept<CatalogEntry>;
  /** A list that had already been answered turned out different when listed again. */
  changed?: () => void;
}
/** What a read makes of the last list known. */
export interface LastList {
  /** The name the list outlives the app under. */
  keptAs: string;
  /**
   * A reader that shows the list is answered at once with the last one known, past its time or from an earlier
   * environment or run of the app, while it is listed again. One that launches from it waits for the current list.
   */
  shown: boolean;
}

const sameCatalog = (a: CatalogEntry, b: CatalogEntry) => a.provider.status === b.provider.status && a.provider.message === b.provider.message && JSON.stringify(a.models) === JSON.stringify(b.models);

/** One cache per harness. A failed refresh preserves only data from that same environment. */
export class ModelCatalogCache {
  private readonly caches = new Map<string, Cached>();
  private readonly now: () => number;
  private readonly ttl: number;

  constructor(private readonly options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.ttl = options.ttl ?? 5 * 60_000;
  }

  read(agent: HarnessId, revision: number, discover: () => Promise<DiscoveredModels>, refresh = false, scope = "", last?: LastList): Promise<CatalogEntry> {
    const key = `${agent}:${scope}`;
    let cache = this.caches.get(key);
    if (!cache || cache.revision !== revision) {
      cache = { revision, earlier: cache?.entry ?? cache?.earlier, keptAs: cache?.keptAs };
      this.caches.set(key, cache);
    }
    if (last) {
      cache.keptAs = last.keptAs;
      if (!cache.entry) cache.earlier ??= this.options.kept?.read(last.keptAs);
    }
    const known = last?.shown && !refresh ? (cache.entry ?? cache.earlier) : undefined;
    if (!cache.pending) {
      if (!refresh && cache.entry && this.now() - (cache.checkedAt ?? 0) < this.ttl) return Promise.resolve(cache.entry);
      cache.pending = this.list(agent, key, cache, discover);
    }
    return known ? Promise.resolve(known) : cache.pending;
  }

  private list(agent: HarnessId, key: string, current: Cached, discover: () => Promise<DiscoveredModels>): Promise<CatalogEntry> {
    return Promise.resolve()
      .then(discover)
      .then(
        (result): CatalogEntry => {
          // A compatibility fallback must not overwrite a previously discovered live catalog.
          if (result.message && current.entry?.provider.refreshedAt !== null && current.entry?.provider.status !== "fallback" && current.entry?.models.length) {
            return { ...current.entry, provider: { ...current.entry.provider, status: "stale", message: result.message } };
          }
          return { ...result, provider: { agent, status: result.message ? "fallback" : "ready", refreshedAt: result.message ? null : this.now(), message: result.message ?? null } };
        },
        (): CatalogEntry => ({
          models: current.entry?.models ?? [],
          provider: {
            agent,
            status: current.entry?.models.length ? "stale" : "error",
            refreshedAt: current.entry?.provider.refreshedAt ?? null,
            message: current.entry?.models.length
              ? "Could not refresh models. Showing the last loaded list. Check the CLI connection and try Refresh models."
              : "Could not load models. Check the CLI connection and try Refresh models.",
          },
        }),
      )
      .then((entry) => {
        const answered = current.entry ?? current.earlier;
        current.entry = entry;
        current.checkedAt = this.now();
        current.earlier = undefined;
        // An environment replaced since lists again on its own, and speaks for itself.
        if (this.caches.get(key) === current && !(answered && sameCatalog(answered, entry))) {
          // A list that could not be read is kept only where there is none to lose: an agent that is not set up then
          // answers the next start at once, and one that failed this time keeps its last good list.
          if (current.keptAs !== undefined && (entry.provider.status === "ready" || !answered?.models.length)) this.options.kept?.write(current.keptAs, entry);
          if (answered) this.options.changed?.();
        }
        return entry;
      })
      .finally(() => {
        current.pending = undefined;
      });
  }
}
