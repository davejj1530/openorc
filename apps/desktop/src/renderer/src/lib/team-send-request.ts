export interface TeamSendRequest {
  body: string;
  attachments: string;
  key: string;
  now: boolean;
}

/** Older drafts queued their messages for the lead and have no explicit delivery choice. */
export function restoreTeamSendRequest(value: unknown): TeamSendRequest | null {
  if (!value || typeof value !== "object" || !("body" in value) || !("attachments" in value) || !("key" in value)) return null;
  if (typeof value.body !== "string" || typeof value.attachments !== "string" || typeof value.key !== "string" || !value.key.length) return null;
  if ("now" in value && typeof value.now !== "boolean") return null;
  return { body: value.body, attachments: value.attachments, key: value.key, now: "now" in value && value.now === true };
}

/** Confirm an unchanged uncertain send even if the retry uses a different shortcut. */
export function prepareTeamSendRequest({
  previous,
  body,
  attachments,
  deliverNow,
  createKey = () => crypto.randomUUID(),
}: {
  previous: TeamSendRequest | null;
  body: string;
  attachments: string[];
  deliverNow: boolean;
  createKey?: () => string;
}): TeamSendRequest {
  const signature = JSON.stringify(attachments);
  if (previous?.body === body && previous.attachments === signature) return previous;
  return { body, attachments: signature, key: createKey(), now: deliverNow };
}
