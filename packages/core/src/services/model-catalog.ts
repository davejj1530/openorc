import type { HarnessId, ModelCatalogProvider, ModelOption } from "@openorc/protocol";

export interface DiscoveredModels {
  models: ModelOption[];
  message?: string;
}
export interface CatalogEntry extends DiscoveredModels {
  provider: ModelCatalogProvider;
}
interface Cached {
  revision: number;
  entry?: CatalogEntry;
  checkedAt?: number;
  pending?: Promise<CatalogEntry>;
}

/** One cache per harness. A failed refresh preserves only data from that same environment. */
export class ModelCatalogCache {
  private readonly caches = new Map<HarnessId, Cached>();
  constructor(
    private readonly now = Date.now,
    private readonly ttl = 5 * 60_000,
  ) {}

  read(agent: HarnessId, revision: number, discover: () => Promise<DiscoveredModels>, refresh = false): Promise<CatalogEntry> {
    let cache = this.caches.get(agent);
    if (!cache || cache.revision !== revision) {
      cache = { revision };
      this.caches.set(agent, cache);
    }
    if (cache.pending) return cache.pending;
    if (!refresh && cache.entry && this.now() - (cache.checkedAt ?? 0) < this.ttl) return Promise.resolve(cache.entry);
    const current = cache;
    current.pending = Promise.resolve()
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
        current.entry = entry;
        current.checkedAt = this.now();
        return entry;
      })
      .finally(() => {
        current.pending = undefined;
      });
    return current.pending;
  }
}
