import { z } from "zod";
import type { ModelCatalog } from "./model-catalog.js";

/**
 * The model an agent runs on OpenOrc Cloud by its own default: the one choice offered for an agent whose models the
 * cloud has not read yet, which a turn sends for the agent's CLI to pick.
 */
export const CLOUD_DEFAULT_MODEL = "";

/**
 * Window-only: the models OpenOrc Cloud runs for the person, as its machines' own agent CLIs list them. Null from a
 * server from before the catalog, or with nobody signed in: the app lists this Mac's then.
 */
export const hostedModelsRpcParams = {
  "cloudModels.catalog": z.object({}).strict(),
};
export interface HostedModelsRpcResults {
  "cloudModels.catalog": ModelCatalog | null;
}
