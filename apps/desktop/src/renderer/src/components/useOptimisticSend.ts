import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emptyRun, messageBody, planSubmit, type Block, type OutgoingMessage, type RunTranscript, type SubmitPlan, type SubmitRequest } from "@openorc/client";
import { draftAttachments, restoreDraftAttachments, type Attachment } from "../lib/composer-attachments";

type Submitter = { submit(request: SubmitRequest, message: OutgoingMessage): Promise<SubmitPlan["kind"]>; pending: boolean };

/** A message shown as sent before the core has recorded it, under the id the core will record it with. */
interface Echo {
  id: string;
  text: string;
  attachments: string[];
  at: number;
  /** When its send came back. A recorded message replaces it; one that never shows, such as a queued one, goes soon after. */
  settledAt?: number;
}

/** How long a sent message may wait for its recorded copy before the echo gives way. */
const SETTLE_MS = 2000;
/** How long a send behind another waits to see that one take hold before planning on what it sees. */
const CATCH_UP_MS = 3000;

function untilCaughtUp(latest: { current: SubmitRequest }, before: SubmitRequest): Promise<void> {
  const caughtUp = () => latest.current.working || latest.current.activeRun?.id !== before.activeRun?.id;
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => (caughtUp() || Date.now() - started > CATCH_UP_MS ? resolve() : setTimeout(check, 50));
    check();
  });
}

/** The conversation as recorded, with the messages still on their way after it. */
function withEchoes(run: RunTranscript | null, echoes: readonly Echo[]): RunTranscript | null {
  if (!echoes.length) return run;
  const recorded = new Set(run?.blocks.map((block) => block.id));
  const waiting = echoes.filter((echo) => !recorded.has(echo.id));
  if (!waiting.length) return run;
  const base = run ?? emptyRun("pending");
  const blocks: Block[] = [
    ...base.blocks,
    ...waiting.map((echo): Block => ({
      id: echo.id,
      kind: "message",
      role: "user",
      text: echo.text,
      streaming: false,
      at: echo.at,
      pending: true,
      ...(echo.attachments.length ? { attachments: echo.attachments } : {}),
    })),
  ];
  return { ...base, blocks, blockIndex: new Map(blocks.map((block, index) => [block.id, index])) };
}

/**
 * Sends the way a chat does. The message shows in the conversation the moment it is sent, and the composer is free
 * again; the core records it under the same id, so the recorded copy takes its place without a flicker. Sends go out
 * one at a time, a later one planned on the conversation as it stands once the one before has taken hold, so two
 * quick messages never start two processes. A send that fails gives its words and files back to the composer. A
 * queued message and anything that is not a thread's next message go the old way: awaited, shown where they land.
 */
export function useOptimisticSend({
  submitter,
  request: current,
  run,
  attachmentsKey,
  restore,
}: {
  submitter: Submitter;
  request: Omit<SubmitRequest, "now">;
  /** The conversation as recorded, which the messages still on their way join at its end. */
  run: RunTranscript | null;
  attachmentsKey: string;
  restore: (text: string) => void;
}) {
  const request: SubmitRequest = { ...current, now: false };
  const threadId = request.target.kind === "thread" ? request.target.threadId : null;
  const [echoes, setEchoes] = useState<Echo[]>([]);
  const [awaiting, setAwaiting] = useState(0);
  const latest = useRef(request);
  latest.current = request;
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  /** Sends still going out, in order, and what the last one went out on and whether it landed. */
  const chain = useRef<Promise<void>>(Promise.resolve());
  const inFlight = useRef(0);
  const last = useRef<{ request: SubmitRequest; landed: boolean } | null>(null);

  const drop = useCallback((id: string) => setEchoes((current) => current.filter((echo) => echo.id !== id)), []);

  const deliver = useCallback(
    async (echo: Echo, now: boolean, message: { text: string; attachments: string[] }, files: Attachment[], behind: boolean) => {
      if (behind && last.current?.landed) await untilCaughtUp(latest, last.current.request);
      const going = { ...latest.current, now };
      last.current = { request: going, landed: false };
      try {
        const kind = await submitter.submit(going, { ...message, messageId: echo.id });
        last.current = { request: going, landed: true };
        if (kind === "queue") drop(echo.id);
        else setEchoes((current) => current.map((other) => (other.id === echo.id ? { ...other, settledAt: Date.now() } : other)));
      } catch {
        drop(echo.id);
        restoreRef.current(message.text);
        restoreDraftAttachments(attachmentsKey, files);
      }
    },
    [submitter, attachmentsKey, drop],
  );

  const send = useCallback(
    async (sent: SubmitRequest, message: { text: string; attachments: string[] }) => {
      const plan = planSubmit(sent);
      if (!threadId || plan.kind === "blocked" || plan.kind === "queue") {
        setAwaiting((count) => count + 1);
        try {
          await submitter.submit(sent, message);
        } finally {
          setAwaiting((count) => count - 1);
        }
        return;
      }
      const echo: Echo = { id: `user-${crypto.randomUUID()}`, text: messageBody(message.text, message.attachments), attachments: message.attachments, at: Date.now() };
      const files = draftAttachments(attachmentsKey, message.attachments);
      setEchoes((current) => [...current, echo]);
      const behind = inFlight.current > 0;
      inFlight.current += 1;
      chain.current = chain.current
        .then(() => deliver(echo, sent.now, message, files, behind))
        .finally(() => {
          inFlight.current -= 1;
        });
    },
    [threadId, submitter, attachmentsKey, deliver],
  );

  useEffect(() => {
    const settled = echoes.filter((echo) => echo.settledAt !== undefined);
    if (!settled.length) return;
    const wait = Math.max(0, Math.min(...settled.map((echo) => echo.settledAt! + SETTLE_MS - Date.now())));
    const timer = setTimeout(() => setEchoes((current) => current.filter((echo) => echo.settledAt === undefined || Date.now() - echo.settledAt < SETTLE_MS)), wait);
    return () => clearTimeout(timer);
  }, [echoes]);

  const shown = useMemo(() => withEchoes(run, echoes), [echoes, run]);

  return { send, run: shown, busy: awaiting > 0 && submitter.pending };
}
