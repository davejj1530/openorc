import { redact } from "@openorc/db";

/**
 * The first `max` code points of `text`. A cut by UTF-16 units can split an emoji's surrogate pair and leave half of it
 * alone, which the phone's JSON reader refuses.
 */
export function leadingText(text: string, max: number): string {
  let end = 0;
  let count = 0;
  for (const point of text) {
    if (count === max) return text.slice(0, end);
    end += point.length;
    count += 1;
  }
  return text;
}

/**
 * Raw text as one line of at most `max` code points, for a notice. Its secrets are masked over the whole text before the
 * cut: a cut through a token leaves a fragment no rule recognizes, which would then reach the lock screen as it is.
 */
export function noticeLine(text: string, max: number): string {
  return leadingText(redact(text).text.replace(/\s+/g, " "), max);
}
