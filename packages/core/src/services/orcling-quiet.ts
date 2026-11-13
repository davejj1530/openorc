/**
 * How an Orcling says nothing. Claude's CLI answers a turn that ends without visible text by asking the model to say
 * something, so silence can't be left unsaid: an Orcling with nothing to add replies with this word alone, and OpenOrc
 * drops that reply before anyone sees or records it. Every agent says nothing the same way.
 */
export const QUIET_REPLY = "NO_REPLY";

/** How an Orcling is told to say nothing. */
export const STAY_QUIET = `reply with only ${QUIET_REPLY}, which nobody sees`;

/** Markdown and quotes a model may wrap a one-word reply in. */
const WRAPPING = /^[\s`"'*_]+|[\s`"'*_.!]+$/g;

/** Whether a reply is the quiet word, however it was wrapped. */
export function isQuietReply(text: string | null | undefined): boolean {
  return Boolean(text) && text!.replace(WRAPPING, "") === QUIET_REPLY;
}

/** Whether text streamed so far could still become the quiet word, so it is held back rather than shown. */
export function mayBeQuiet(text: string): boolean {
  const start = text.replace(/^[\s`"'*_]+/, "").trimEnd();
  if (QUIET_REPLY.startsWith(start)) return true;
  return start.startsWith(QUIET_REPLY) && start.replace(WRAPPING, "") === QUIET_REPLY;
}
