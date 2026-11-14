import { z } from "zod";
import { AvailableGithubInstallation } from "@openorc/protocol";

export const wireGithubInstallation = z.object({
  id: z.string(),
  accountLogin: z.string(),
  accountType: z.enum(["User", "Organization"]).default("User"),
  suspended: z.boolean().default(false),
  settingsUrl: z.string().nullable().default(null),
});
export const wireGithubStatus = z.object({
  configured: z.boolean(),
  installations: z.array(wireGithubInstallation),
  available: z.array(AvailableGithubInstallation).default([]),
});
export const wireGithubChoose = z.object({ kind: z.literal("choose"), available: z.array(AvailableGithubInstallation) });
