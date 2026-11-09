import { z } from "zod";
import { ClaudeAccountId } from "./claude-accounts.js";
import type { Memory, PermissionPreset, Run, RunMode } from "./domain.js";
import { executionModeAvailable, executionModeSettings } from "./execution-mode.js";
import { ModelExecutionSettings } from "./execution-target.js";

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
    /** The Claude account it runs on whenever its model is Claude's. Without one, a new Orcling takes the default account and a saved one keeps its own. */
    claudeAccountId: ClaudeAccountId.optional(),
  })
  .strict();
export type OrclingDraft = z.infer<typeof OrclingDraft>;

/**
 * When an Orcling wakes up on its own to see whether there is anything worth texting about: as OpenOrc opens, or at
 * a time of day on chosen weekdays (0 is Sunday). A time missed while OpenOrc was closed wakes it once when it opens.
 */
export const OrclingWake = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("startup") }).strict(),
  z
    .object({
      kind: z.literal("time"),
      at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    })
    .strict(),
]);
export type OrclingWake = z.infer<typeof OrclingWake>;
export const OrclingWakes = z
  .array(OrclingWake)
  .max(12)
  .refine((wakes) => wakes.filter((wake) => wake.kind === "startup").length <= 1, "Waking when OpenOrc opens is one choice.");

/** One rule's identity: the same time on the same days is the same wake, however it was listed. */
export function orclingWakeKey(wake: OrclingWake): string {
  return wake.kind === "startup" ? "startup" : `time@${wake.at}:${[...new Set(wake.days)].sort().join("")}`;
}

/** A saved identity: the same Orcling in its own thread and wherever it is asked to help. */
export interface Orcling extends OrclingDraft {
  id: string;
  claudeAccountId: string;
  /** Its one personal conversation. */
  threadId: string;
  wakes: OrclingWake[];
  createdAt: number;
  updatedAt: number;
}

/** A tapback on one bubble of a message in an Orcling's own conversation. */
export const Reaction = z.enum(["heart", "like", "dislike", "haha", "wow", "sad"]);
export type Reaction = z.infer<typeof Reaction>;
export const reactionEmoji: Record<Reaction, string> = { heart: "❤️", like: "👍", dislike: "👎", haha: "😂", wow: "😮", sad: "😢" };

export interface MessageReaction {
  runId: string;
  messageId: string;
  /** Which bubble of the message, as chatBubbles splits it. */
  part: number;
  /** The Orcling that reacted, or null for the person. */
  orclingId: string | null;
  reaction: Reaction;
  at: number;
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/**
 * A text in an Orcling's own conversation as the messages it arrives as: one per paragraph, the way people text. A
 * code block stays whole, and a list stays one message even when its items are spaced apart.
 */
export function chatBubbles(text: string): string[] {
  const bubbles: string[] = [];
  let current: string[] = [];
  let fenced = false;
  const flush = () => {
    const bubble = current.join("\n").trim();
    current = [];
    if (!bubble) return;
    const previous = bubbles.at(-1);
    if (previous !== undefined && LIST_ITEM.test(bubble) && LIST_ITEM.test(previous.split("\n").at(-1) ?? "")) bubbles[bubbles.length - 1] = `${previous}\n\n${bubble}`;
    else bubbles.push(bubble);
  };
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && !line.trim()) flush();
    else current.push(line);
  }
  flush();
  return bubbles;
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
  /** Replaces when the Orcling wakes up on its own; an empty list leaves it waiting for you. */
  "orclings.wakes.save": z.object({ id, wakes: OrclingWakes }).strict(),
  /** Every tapback in an Orcling's own conversation. */
  "orclings.reactions": z.object({ threadId: id }).strict(),
  /** Your tapback on one bubble of the Orcling's message, replacing your earlier one there; null takes it back. The Orcling hears it on its next turn. */
  "orclings.react": z.object({ threadId: id, runId: id, messageId: id, part: z.number().int().min(0), reaction: Reaction.nullable() }).strict(),
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
  "orclings.wakes.save": Orcling;
  "orclings.reactions": MessageReaction[];
  "orclings.react": null;
}
