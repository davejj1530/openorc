import { z } from "zod";
import type { Memory, PermissionPreset, Run, RunMode } from "./domain.js";
import { executionModeAvailable, executionModeSettings } from "./execution-mode.js";
import { ModelExecutionSettings } from "./orchestration.js";

/**
 * How an Orcling looks. Each number picks a variant in the Orcling Rive file,
 * where 0 is the classic mascot; the colors are six-digit hex.
 */
export const orclingLookRanges = { shape: 12, eyes: 5, texture: 4, glasses: 4, accessory: 6 } as const;
export type OrclingLookPart = keyof typeof orclingLookRanges;
const variant = (part: OrclingLookPart) =>
  z
    .number()
    .int()
    .min(0)
    .max(orclingLookRanges[part] - 1);
const HexColor = z.string().regex(/^#[0-9a-f]{6}$/i);
export const OrclingLook = z
  .object({
    shape: variant("shape"),
    eyes: variant("eyes"),
    texture: variant("texture"),
    glasses: variant("glasses"),
    accessory: variant("accessory"),
    bodyColor: HexColor,
    eyeColor: HexColor,
  })
  .strict();
export type OrclingLook = z.infer<typeof OrclingLook>;
export const defaultOrclingLook: OrclingLook = { shape: 0, eyes: 0, texture: 0, glasses: 0, accessory: 0, bodyColor: "#52b8a0", eyeColor: "#1b1c20" };

/** Allow runs without asking; Approve asks before every command or edit. */
export const OrclingPermission = z.enum(["allow", "approve"]);
export type OrclingPermission = z.infer<typeof OrclingPermission>;

/**
 * An Orcling's name as its folder: lowercase letters and numbers joined by dashes. Names that
 * share a handle, such as "Rini" and "rini!", cannot belong to two Orclings.
 */
export function orclingHandle(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

export const OrclingDraft = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .refine((name) => orclingHandle(name) !== "", "An Orcling's name needs a letter or a number."),
    look: OrclingLook,
    settings: ModelExecutionSettings,
    permission: OrclingPermission,
  })
  .strict();
export type OrclingDraft = z.infer<typeof OrclingDraft>;

/** A saved identity: the same Orcling in its own thread and wherever it is asked to help. */
export interface Orcling extends OrclingDraft {
  id: string;
  /** Its one personal conversation. */
  threadId: string;
  createdAt: number;
  updatedAt: number;
}

export interface OrclingInstructionsVersion {
  version: number;
  body: string;
  /** Who wrote this version: you, or the Orcling itself. */
  author: "user" | "orcling";
  /** The Orcling's reason, or which version a restore brought back. */
  note: string | null;
  createdAt: number;
}

/**
 * How an Orcling may act everywhere it goes, before a place's own rules tighten it. Approve on a
 * harness that cannot ask before each command, such as OpenCode, stays read-only instead.
 */
export function orclingExecution(o: Pick<OrclingDraft, "permission" | "settings">): { mode: RunMode; permissionMode: PermissionPreset } {
  if (o.permission === "allow") return executionModeSettings("autonomous");
  return executionModeSettings(executionModeAvailable(o.settings.agent, "review") ? "review" : "plan");
}

const id = z.string().min(1);
export const orclingRpcParams = {
  "orclings.list": z.object({}).strict(),
  "orclings.create": z.object({ draft: OrclingDraft }).strict(),
  "orclings.update": z.object({ id, draft: OrclingDraft }).strict(),
  /** Removes the Orcling, its instructions, memories and conversation. Threads it helped in keep their history. */
  "orclings.delete": z.object({ id }).strict(),
  /** Every version of its instructions, newest first. */
  "orclings.instructions": z.object({ id }).strict(),
  "orclings.instructions.save": z.object({ id, body: z.string().max(20_000) }).strict(),
  /** Brings an earlier version back as the newest one, so the history keeps every change. */
  "orclings.instructions.restore": z.object({ id, version: z.number().int().min(1) }).strict(),
  /** What the Orcling remembers; edit and remove them with the memory methods. */
  "orclings.memories": z.object({ id }).strict(),
  /** Asks an Orcling in a conversation that belongs to another agent. It answers there, and the conversation's agent hears the answer on its next turn. */
  "orclings.ask": z.object({ id, threadId: id, prompt: z.string().min(1), attachments: z.array(z.string()).optional() }).strict(),
  /** Gives a project conversation to an Orcling, or with null back to its plain model. */
  "orclings.assign": z.object({ threadId: id, orclingId: id.nullable() }).strict(),
};

export interface OrclingRpcResults {
  "orclings.list": Orcling[];
  "orclings.create": Orcling;
  "orclings.update": Orcling;
  "orclings.delete": null;
  "orclings.instructions": OrclingInstructionsVersion[];
  "orclings.instructions.save": OrclingInstructionsVersion;
  "orclings.instructions.restore": OrclingInstructionsVersion;
  "orclings.memories": Memory[];
  "orclings.ask": Run;
  "orclings.assign": null;
}
