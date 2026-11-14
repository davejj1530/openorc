import type { SubmitRequest } from "@openorc/client";
import { readDraft, removeDraft, writeDraft } from "./drafts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The id of one exact cloud message with files, kept with its draft. Sending the same words, files, delivery and
 * settings again, after an answer that never came, is the same message, so the server attaches its files once. Any
 * change is a new message. Its files are single-use uploads, so a later message can never match a sent one.
 */
export async function hostedIntentId(draftKey: string, intent: unknown): Promise<string> {
  const digest = await digestOf(intent);
  const saved = readDraft(intentKey(draftKey), { digest: "", id: "" });
  if (saved.digest === digest && UUID.test(saved.id)) return saved.id;
  const id = crypto.randomUUID();
  writeDraft(intentKey(draftKey), { digest, id });
  return id;
}

/** A cloud message with files under its exact id, kept in the conversation's draft; any other message as it is. */
export async function withHostedIntent(draftKey: string | null, sent: SubmitRequest, message: { text: string; attachments: string[] }) {
  if (!draftKey || !message.attachments.length) return message;
  const { now, choice, mode, permission, task } = sent;
  const intent = { text: message.text, attachments: message.attachments, now, choice, mode, permission, task: task?.context ?? null };
  return { ...message, requestId: await hostedIntentId(draftKey, intent) };
}

/** The server has the message: the next send is a new one. */
export function forgetHostedIntent(draftKey: string): void {
  removeDraft(intentKey(draftKey));
}

const intentKey = (draftKey: string) => `${draftKey}.intent`;

async function digestOf(intent: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(intent)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
