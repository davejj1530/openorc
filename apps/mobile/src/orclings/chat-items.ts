import type { Block, ChatRow } from "@openorc/client";

type Message = Extract<Block, { kind: "message" }>;

/**
 * One row of an Orcling's chat on the phone: a time over a stretch, the person's message, one bubble of the Orcling's
 * (its face beside the last of a run), something it drew, a card that needs the person, or the typing dots. `gap` is the space above.
 */
export type ChatItem = { key: string; gap: number } & (
  | { kind: "time"; at: number }
  | { kind: "mine"; block: Message }
  | { kind: "bubble"; block: Message; part: number; text: string; first: boolean; last: boolean }
  | { kind: "card"; block: Block }
  | { kind: "visualization"; row: Extract<ChatRow, { kind: "visualization" }> }
  | { kind: "typing"; first: boolean }
);

/** Bubbles of one run sit this close; anything else stands apart. */
const IN_RUN = 3;
const APART = 14;

/** The chat's rows as list items, one per bubble, with the typing dots at the end while the Orcling works. */
export function chatItems(rows: readonly ChatRow[], typing: boolean): ChatItem[] {
  const items: ChatItem[] = [];
  const inRun = () => items.at(-1)?.kind === "bubble";
  for (const row of rows) {
    switch (row.kind) {
      case "time":
        items.push({ kind: "time", key: row.id, gap: items.length ? 20 : 8, at: row.at });
        break;
      case "mine":
        items.push({ kind: "mine", key: row.id, gap: APART, block: row.block });
        break;
      case "card":
        items.push({ kind: "card", key: `card:${row.id}`, gap: APART, block: row.block });
        break;
      case "visualization":
        items.push({ kind: "visualization", key: `visualization:${row.id}`, gap: APART, row });
        break;
      case "theirs":
        row.bubbles.forEach((text, part) => {
          const continues = inRun();
          const previous = items.at(-1);
          if (previous?.kind === "bubble") previous.last = false;
          items.push({ kind: "bubble", key: `${row.id}:${part}`, gap: continues ? IN_RUN : APART, block: row.block, part, text, first: !continues, last: true });
        });
        break;
    }
  }
  if (typing) {
    const continues = inRun();
    const previous = items.at(-1);
    if (previous?.kind === "bubble") previous.last = false;
    items.push({ kind: "typing", key: "typing", gap: continues ? IN_RUN : APART, first: !continues });
  }
  return items;
}

/** The Orcling's body color at the tint its bubbles take: 14% over light grounds, 20% over dark. */
export function bubbleTint(hex: string, mode: "light" | "dark"): string {
  const alpha = Math.round((mode === "dark" ? 0.2 : 0.14) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${alpha}`;
}
