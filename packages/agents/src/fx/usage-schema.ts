import { z } from "zod";

const name = z.string().trim().min(1).max(160);
const metric = z.number().nonnegative().nullish().catch(null);
const timestamp = z.number().int().positive().max(8.64e15).nullish().catch(null);
const balance = z
  .string()
  .trim()
  .regex(/^-?\d+(?:\.\d+)?$/)
  .refine((value) => Number.isFinite(Number(value)))
  .nullish()
  .catch(null);
const window = z.object({ used_percent: metric, window_seconds: metric, resets_at_ms: timestamp });

/** Only account limits cross the boundary; activity, profile and raw failure details stay in the CLI. */
export const fxUsageReport = z.object({
  kind: z.literal("usage"),
  schema_version: z.literal(2),
  source: z.enum(["ai_gateway", "chatgpt", "grok"]),
  status: z.enum(["ready", "fetching", "failed", "unavailable"]),
  reason: z.enum(["no_gateway_sign_in", "no_team", "unsupported_provider", "refresh_needed", "refused"]).nullish().catch(null),
  fetched_at_ms: timestamp,
  budget: z
    .object({ limit: metric, spent: metric, period: z.enum(["daily", "weekly", "monthly", "none"]) })
    .nullish()
    .catch(null),
  codex: z
    .object({
      plan: name.nullish().catch(null),
      limits: z.array(z.object({ name, reached: z.boolean().default(false), primary: window.nullish(), secondary: window.nullish() })).max(32),
      credits: z.object({ unlimited: z.boolean(), balance }).nullish().catch(null),
      spend_limit_reached: z.boolean().default(false),
    })
    .nullish()
    .catch(null),
  grok: z
    .object({
      used_percent: metric,
      period: z.enum(["weekly", "monthly"]).nullish().catch(null),
      resets_at_ms: timestamp,
      prepaid_cents: metric,
      on_demand_used_cents: metric,
      on_demand_cap_cents: metric,
      settings: z
        .object({ plan: name.nullish().catch(null) })
        .nullish()
        .catch(null),
    })
    .nullish()
    .catch(null),
});

export const fxCreditsReport = z.object({ kind: z.literal("credits"), balance, plan: name.nullish().catch(null) });
export type FxUsageReport = z.infer<typeof fxUsageReport>;
export type FxCreditsReport = z.infer<typeof fxCreditsReport>;
