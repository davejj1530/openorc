/** A passage picked out of a message, with what the person wrote about it. */
export interface Quote {
  id: string;
  text: string;
  note: string;
}

/** A message as the agent reads it: each passage quoted with its note under it, then the words written. */
export function quotedMessage(quotes: readonly Quote[], text: string): string {
  const passages = quotes.map((quote) => {
    const quoted = quote.text
      .split("\n")
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n");
    return quote.note ? `${quoted}\n${quote.note}` : quoted;
  });
  return [...passages, text].filter(Boolean).join("\n\n");
}

/** A message's words in runs: the passages it quotes, without the `>` each line starts with, and the words between them. */
export function quoteRuns(text: string): { quote: boolean; text: string }[] {
  const runs: { quote: boolean; text: string }[] = [];
  for (const line of text.split("\n")) {
    const quote = /^>(?: |$)/.test(line);
    const words = quote ? line.slice(2) : line;
    const last = runs.at(-1);
    if (last?.quote === quote) last.text += `\n${words}`;
    else runs.push({ quote, text: words });
  }
  return runs;
}
