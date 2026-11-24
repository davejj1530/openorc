/** Where spoken words go in a draft: in place of what was selected, or at the caret, where `from` and `to` meet. */
export interface SpokenPlace {
  text: string;
  from: number;
  to: number;
}

/**
 * The draft with `words` spoken into their place, a space on either side where the message needs one, and where the
 * caret stands after them. With no words the draft is as it was, what was selected included.
 */
export function withSpoken(place: SpokenPlace, words: string): { text: string; caret: number } {
  if (!words) return { text: place.text, caret: place.from };
  const before = place.text.slice(0, place.from);
  const after = place.text.slice(place.to);
  const head = before + (before && !/\s$/.test(before) ? " " : "") + words;
  return { text: head + (after && !/^\s/.test(after) ? " " : "") + after, caret: head.length };
}

/** What a recording has heard: the words that are settled, and the ones still being made out. */
export interface Heard {
  settled: string;
  open: string;
}

export const HEARD_NOTHING: Heard = { settled: "", open: "" };

/**
 * A recognizer's next result. An open result replaces the last open one; a final one settles it, and what comes after
 * starts anew, as a recognizer that works a pause at a time sends it.
 */
export const hear = (heard: Heard, transcript: string, final: boolean): Heard => (final ? { settled: heard.settled + transcript, open: "" } : { settled: heard.settled, open: transcript });

/** Everything heard so far as it goes into the draft. */
export const heardWords = (heard: Heard): string => (heard.settled + heard.open).replace(/\s+/g, " ").trim();

/**
 * The language to recognize in: the device's own where it has a model on the device, else another form of the same
 * language that does. None where the device holds no model for the language at all.
 */
export function pickLanguage(device: string, onDevice: readonly string[]): string | null {
  const wanted = device.replace(/_/g, "-");
  if (onDevice.includes(wanted)) return wanted;
  const language = wanted.split("-")[0]!.toLowerCase();
  const same = onDevice.filter((locale) => locale.split("-")[0]!.toLowerCase() === language);
  const home = language === "en" ? "en-US" : `${language}-${language.toUpperCase()}`;
  return same.find((locale) => locale === home) ?? same[0] ?? null;
}
