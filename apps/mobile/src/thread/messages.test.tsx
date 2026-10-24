// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Reply } from "./messages";
import { emptyRowMemo, transcriptRows, type Row } from "./rows";
import { activity, type runStore } from "./test-fixtures/run-store";

/** The run store the reply reads, and every Markdown view: how many mounted, and what each render drew. */
const probe = vi.hoisted(() => ({ store: null as ReturnType<typeof runStore> | null, mounts: 0, renders: [] as { text: string; streaming: boolean }[] }));

vi.mock("../client", async () => {
  const { runStore } = await import("./test-fixtures/run-store");
  probe.store = runStore();
  return { client: probe.store.client };
});
vi.mock("./Markdown", () => ({
  Markdown: function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
    useEffect(() => {
      probe.mounts++;
    }, []);
    probe.renders.push({ text, streaming });
    return <div>{text}</div>;
  },
}));

afterEach(cleanup);

type ReplyRow = Extract<Row, { kind: "reply" }>;
const memo = emptyRowMemo();
function replyRows(): ReplyRow[] {
  const run = probe.store!.client.runs.get("r")!;
  return transcriptRows(run.blocks, activity(run), "r", memo).filter((row): row is ReplyRow => row.kind === "reply");
}
const reply = (row: ReplyRow) => <Reply text={row.text} streaming={row.streaming} source={row.source} />;
const paragraph = (n: number) => `Paragraph ${n}. ${"A sentence that fills the reply. ".repeat(12)}\n\n`;

it("keeps one Markdown view for a piece from its first words through finishing, and for the next piece the list hands it", () => {
  const { frame } = probe.store!;
  frame(
    { type: "session.started", agent: "codex", externalSessionId: "s", model: "gpt", tools: [] },
    { type: "turn.started", turnId: "t1" },
    { type: "message.completed", messageId: "ask", role: "user", text: "Explain" },
  );
  frame({ type: "message.delta", messageId: "m", role: "assistant", text: "Hello " });
  const view = render(reply(replyRows()[0]!));
  expect(probe.renders.at(-1)).toEqual({ text: "Hello ", streaming: true });

  // Paragraphs stream in until the reply starts its second piece; the first piece's row holds still meanwhile.
  for (let n = 1; replyRows().length < 2; n++) act(() => void frame({ type: "message.delta", messageId: "m", role: "assistant", text: paragraph(n) }));
  expect(probe.renders.at(-1)!.streaming).toBe(true);
  const [first, second] = replyRows();
  expect(first!.streaming).toBe(false);
  view.rerender(reply(first!));
  expect(probe.mounts).toBe(1);
  expect(probe.renders.at(-1)).toEqual({ text: first!.text, streaming: false });

  // Finished, it no longer hears the run.
  const drawn = probe.renders.length;
  act(() => void frame({ type: "message.delta", messageId: "m", role: "assistant", text: "more " }));
  expect(probe.renders.length).toBe(drawn);

  // The list hands this view to the second piece, still streaming: the same Markdown streams again.
  view.rerender(reply(second!));
  expect(probe.mounts).toBe(1);
  expect(probe.renders.at(-1)).toMatchObject({ streaming: true, text: expect.stringMatching(/more $/) });
});
