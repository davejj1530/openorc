import { z } from "zod";
import { HarnessId } from "./harness.js";
import { PermissionPreset } from "./domain.js";

export const SlackClientConfig = z
  .object({
    relayUrl: z.string().url().max(200),
    deviceKey: z.string().min(32).max(200).optional(),
    /** Optional starting fallback; messages and thread context choose the project first. */
    projectId: z.string().default(""),
    agent: HarnessId,
    model: z.string().max(200).optional(),
    mode: z.enum(["plan", "act"]).optional(),
    permissionMode: PermissionPreset.default("review"),
  })
  .strict();
export type SlackClientConfig = z.infer<typeof SlackClientConfig>;

export const SlackDirectConfig = z
  .object({
    botToken: z
      .string()
      .regex(/^xoxb-[A-Za-z0-9-]+$/)
      .max(500)
      .optional(),
    appToken: z
      .string()
      .regex(/^xapp-[A-Za-z0-9-]+$/)
      .max(500)
      .optional(),
    userId: z.string().regex(/^[UW][A-Z0-9]+$/),
    agent: HarnessId,
    model: z.string().max(200).optional(),
    mode: z.enum(["plan", "act"]).optional(),
    permissionMode: PermissionPreset.default("review"),
  })
  .strict();
export type SlackDirectConfig = z.infer<typeof SlackDirectConfig>;

export const slackRpcParams = {
  "slack.status": z.object({}),
  "slack.direct.save": SlackDirectConfig,
  "slack.direct.connect": z.object({}),
  "slack.direct.disconnect": z.object({}),
  "slack.host.save": z
    .object({
      botToken: z
        .string()
        .regex(/^xoxb-[A-Za-z0-9-]+$/)
        .max(500)
        .optional(),
      appToken: z
        .string()
        .regex(/^xapp-[A-Za-z0-9-]+$/)
        .max(500)
        .optional(),
      /** Retained for existing installations; mentions now work in all joined channels. */
      channelId: z
        .string()
        .regex(/^[CG][A-Z0-9]+$/)
        .or(z.literal(""))
        .default(""),
      port: z.number().int().min(1024).max(65535).default(47831),
    })
    .strict(),
  "slack.host.connect": z.object({}),
  "slack.host.disconnect": z.object({}),
  "slack.device.add": z.object({ userId: z.string().regex(/^[UW][A-Z0-9]+$/), label: z.string().trim().min(1).max(80) }).strict(),
  "slack.device.remove": z.object({ id: z.string().min(1) }).strict(),
  "slack.client.save": SlackClientConfig,
  "slack.client.connect": z.object({}),
  "slack.client.disconnect": z.object({}),
};

export interface SlackStatus {
  mode: "direct" | "relay";
  direct: {
    configured: boolean;
    enabled: boolean;
    connected: boolean;
    busy: boolean;
    error: string | null;
    config: Omit<SlackDirectConfig, "botToken" | "appToken"> | null;
    workspace: string | null;
    ownerName: string | null;
    botId: string | null;
  };
  host: { configured: boolean; enabled: boolean; connected: boolean; channelId: string; port: number; workspace: string | null; error: string | null };
  devices: { id: string; userId: string; label: string; online: boolean }[];
  client: {
    configured: boolean;
    enabled: boolean;
    connected: boolean;
    config: Omit<SlackClientConfig, "deviceKey"> | null;
    userId: string | null;
    busy: boolean;
    error: string | null;
  };
}
