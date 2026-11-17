import type { TeamMessage } from "@openorc/protocol";
import { expect, it } from "vitest";
import { chatItems } from "./chat-items";

const person = (id: string, name: string) => ({ id, name, image: null });
const MARA = person("u-mara", "Mara Okafor");
const RILEY = person("u-riley", "Riley Chen");
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 18, 3, minutes)).toISOString();
const message = (seq: number, who: typeof MARA, minutes: number) =>
  ({
    id: `m${seq}`,
    channelId: "c1",
    seq,
    actor: { kind: "person", person: who },
    body: `#${seq}`,
    files: [],
    reactions: [],
    replyTo: null,
    pinned: null,
    call: null,
    createdAt: at(minutes),
  }) as unknown as TeamMessage;
function line(item: ReturnType<typeof chatItems>[number]): string {
  if (item.kind === "theirs") return `theirs ${item.message.id}${item.first ? " first" : ""}${item.last ? " last" : ""}`;
  if (item.kind === "mine") return `mine ${item.message.id}`;
  return item.kind;
}
const outline = (items: ReturnType<typeof chatItems>) => items.map(line);

it("runs one person's messages under one name, puts the reader's own on the right, and a time over each stretch", () => {
  const messages = [message(1, MARA, 0), message(2, MARA, 1), message(3, RILEY, 2), message(4, MARA, 3), message(5, MARA, 3 + 60)];
  expect(outline(chatItems(messages, RILEY.id, null))).toEqual(["time", "theirs m1 first", "theirs m2 last", "mine m3", "theirs m4 first last", "time", "theirs m5 first last"]);
});

it("draws New messages over the first message after the reader's place that someone else wrote, starting a new run", () => {
  const messages = [message(1, MARA, 0), message(2, MARA, 1), message(3, RILEY, 2), message(4, MARA, 3)];
  expect(outline(chatItems(messages, RILEY.id, 1))).toEqual(["time", "theirs m1 first last", "new", "theirs m2 first last", "mine m3", "theirs m4 first last"]);
  expect(outline(chatItems(messages, RILEY.id, 4))).not.toContain("new");
});
