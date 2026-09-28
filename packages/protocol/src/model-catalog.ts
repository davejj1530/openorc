import type { HarnessId } from "./harness.js";
import type { ModelOption } from "./rpc.js";

export interface ModelCatalogProvider {
  agent: HarnessId;
  status: "ready" | "fallback" | "stale" | "error";
  refreshedAt: number | null;
  message: string | null;
}

export interface ModelCatalog {
  models: ModelOption[];
  providers: ModelCatalogProvider[];
}
