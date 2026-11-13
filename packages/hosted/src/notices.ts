/**
 * What a cloud thread tells the person when they look elsewhere, as this Mac's own threads do: an approval or a
 * question it waits on, and a turn that finished or failed. Read from two listings of the rows, before and after, so
 * every thread of the account is covered without watching each one; a turn's reply is read from the end of its log.
 */
import { harnessShortName, hostedRunId, type CorePush } from "@openorc/protocol";
import type { Requests } from "./session.js";
import { toAppEvent } from "./translate.js";
import { ROUTES, type WireThread } from "./wire.js";

/** A notice as the core hands it to the windows: its words are the core's to clip and redact. */
export type HostedNotice = Omit<Extract<CorePush, { type: "notify" }>, "type" | "id">;

/** How much of a log's end is read for the turn that just ended. */
const TAIL = 40;

const runs = (row: WireThread) => row.turn !== null || row.status === "working";

/** What changed between two listings that the person hears of: a new ask, or a turn that ended with nothing waiting. */
export function noticed<Row extends WireThread>(before: readonly Row[], after: readonly Row[]): { row: Row; was: "ask" | "ended" }[] {
  const old = new Map(before.map((row) => [row.id, row]));
  return after.flatMap((row): { row: Row; was: "ask" | "ended" }[] => {
    const was = old.get(row.id);
    if (!was) return [];
    if (row.ask && row.ask.id !== was.ask?.id) return [{ row, was: "ask" }];
    if (runs(was) && !runs(row) && !row.ask) return [{ row, was: "ended" }];
    return [];
  });
}

/** The notice for an ask, in the words this Mac's own asks use. */
export function askNotice(row: WireThread): HostedNotice {
  const ask = row.ask!;
  const agent = harnessShortName(row.settings.agent);
  const question = ask.kind === "user_input";
  let body = `${agent} wants to use ${ask.detail}`;
  if (question) body = `${agent} has a question`;
  else if (ask.kind === "command") body = `${agent} wants to run ${ask.detail}`;
  return { kind: question ? "question" : "approval", threadId: row.id, taskId: null, title: row.title, body, runId: hostedRunId(row.id), approvalId: ask.id };
}

/** The notice for a turn that ended: finished with its reply, or failed; none for a turn the person stopped. */
export async function endNotice(space: Requests, row: WireThread): Promise<HostedNotice | null> {
  const tail = await space.request(ROUTES.events(row.id, { before: row.head + 1 }, TAIL));
  const events = tail.events.map((event) => toAppEvent(row.id, event));
  const end = events.findLast((event) => event.type === "turn.completed");
  if (end?.type !== "turn.completed" || end.status === "cancelled") return null;
  const base = { threadId: row.id, taskId: null, title: row.title } as const;
  if (end.status !== "success") return { ...base, kind: "error", body: "The turn failed." };
  const said = events.findLast((event) => event.type === "message.completed" && event.role === "assistant" && Boolean(event.text.trim()));
  const text = end.resultText ?? (said?.type === "message.completed" ? said.text : null);
  return { ...base, kind: "finished", body: text?.trim() ? text : "The agent finished its turn." };
}
