export interface Args {
  flags: Set<string>;
  values: Map<string, string[]>;
  positional: string[];
}

/** A command's words as flags, the values of the flags in `valued`, and the rest. `-rnA3` is r, n and A with 3. */
export function parseArgs(words: string[], valued: Set<string>): Args {
  const args: Args = { flags: new Set(), values: new Map(), positional: [] };
  const add = (flag: string, value: string | undefined) => {
    args.flags.add(flag);
    if (value !== undefined) args.values.set(flag, [...(args.values.get(flag) ?? []), value]);
  };
  for (let at = 0; at < words.length; at++) {
    const word = words[at]!;
    if (word === "--") {
      args.positional.push(...words.slice(at + 1));
      break;
    }
    if (/^--[^=]+=/.test(word)) add(word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1));
    else if (word.startsWith("--")) add(word, valued.has(word) ? words[++at] : undefined);
    else if (/^-[^\d]/.test(word)) at += shortFlags(word, valued, add, words[at + 1]);
    else args.positional.push(word);
  }
  return args;
}

/** Reads a cluster of short flags; returns 1 when the last one took the next word as its value. */
function shortFlags(word: string, valued: Set<string>, add: (flag: string, value: string | undefined) => void, next: string | undefined): number {
  for (let index = 1; index < word.length; index++) {
    const flag = word[index]!;
    if (!valued.has(flag)) {
      add(flag, undefined);
      continue;
    }
    const attached = word.slice(index + 1);
    add(flag, attached || next);
    return attached ? 0 : 1;
  }
  return 0;
}
