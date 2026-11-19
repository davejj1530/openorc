import {
  canStopTurn,
  draftOfNote,
  handoffCard,
  handoffLabel,
  placeUnreachable,
  steerBlock,
  queueBlock,
  sendPayer,
  sendsBlocked,
  threadReadOnlyReason,
  threadSendBlock,
  threadTogether,
  threadWriteBlock,
  withOthers,
  type HandoffAction,
  type SendBlockAction,
  type SendPayer,
} from "@openorc/client";
import { movingHold, type PermissionPreset, type RunMode, type ThreadMoving, type ThreadSummary } from "@openorc/protocol";
import type { ReactNode, RefObject } from "react";
import { useRpc, useRpcMutation } from "../lib/client";
import { cn } from "../lib/cn";
import { CLOUD_MODEL_LIMITS } from "../lib/cloud-model-limits";
import { useRouter } from "../lib/router";
import { homeRelative } from "../lib/home-path";
import { machine, revealLabel, thisComputer } from "../lib/this-computer";
import { useCloudMove, useStartCloudMove } from "./CloudMoveDialog";
import type { ComposerHandle } from "./Composer";
import type { ModelChoice } from "./ModelPicker";
import { Button, TextButton } from "./ui";

const card = "rounded-xl bg-surface px-3.5 py-1.5 text-base";
const FILES = "Files can't be sent to OpenOrc Cloud yet.";

/** What a cloud thread's composer leaves out: what OpenOrc Cloud does not take yet, absent or disabled with its reason. */
export interface CloudComposerLimits {
  attachmentsDisabledReason: string;
  modelLimits: typeof CLOUD_MODEL_LIMITS;
}

const CLOUD_LIMITS: CloudComposerLimits = { attachmentsDisabledReason: FILES, modelLimits: CLOUD_MODEL_LIMITS };

/**
 * What an OpenOrc Cloud thread adds to its conversation, and nothing for any other thread:
 *   notice     the card above the composer when a send cannot start a turn, with its words and its way on, or when
 *              the server says this person cannot run the agent in this thread, in its words
 *   blocked    the same words, as the reason Send is disabled
 *   limits     the composer's controls a cloud thread leaves out, spread over its props
 *   onReady    the composer's ready signal: writing begins, so the thread is made ready for the message; in a thread
 *              others are in, only once there are words, never on focus alone
 *   shown      the composer's error line, without a refusal the card already says in the same words
 *   hosted     a cloud thread runs elsewhere, so this Mac's skills and connectors are not offered in it
 *
 * A thread moving between this computer and the cloud, from either side, takes no message until it is there, and one
 * whose move stopped says why above its composer, with the move again.
 *
 * The block is derived once from `account.status`, the read Settings makes, so when a sign-in or a purchase lands the
 * card goes by itself. The thread is made ready when the message box takes focus, and when a draft starts from empty;
 * the core asks the server at most once a minute and never while the account says a turn cannot start.
 */
export function useHostedComposer(
  thread: ThreadSummary | null,
  settings: { choice: ModelChoice | null; mode: RunMode; permission: PermissionPreset },
  composer: RefObject<ComposerHandle | null>,
  /** What the composer holds now, so a note already staged in it is not offered again. */
  draft: string,
): {
  hosted: boolean;
  notice: ReactNode;
  blocked: string | null;
  limits: Partial<CloudComposerLimits> & {
    readOnlyReason: string | null;
    sendPayer?: SendPayer | null;
    queueBlocked?: string | null;
    canStopTurn?: boolean | undefined;
    steerable?: false;
    steerReason?: string;
  };
  onReady?: (why?: "focus" | "words") => void;
  shown: (error: string | null | undefined) => string | null | undefined;
} {
  const hosted = thread?.owner?.brain === "hosted";
  const writeBlock = threadTogether(thread) ? threadWriteBlock(thread) : null;
  const limits = { ...(hosted ? CLOUD_LIMITS : {}), readOnlyReason: readOnlyReason(thread, writeBlock) };
  const moveCard = moveFailedCard(thread);
  const account = useRpc("account.status", {}, { enabled: hosted });
  const ready = useRpcMutation("threads.ready");
  const blocked = sendsBlocked(thread);
  const agent = settings.choice?.agent ?? thread?.agent ?? "";
  const turn = { agent, model: settings.choice?.model ?? thread?.model ?? null };
  const block = threadSendBlock(thread, account.data, turn);
  const stopping = steerBlock(thread);
  const together = {
    sendPayer: sendPayer(thread),
    queueBlocked: queueBlock(thread, account.data, turn),
    canStopTurn: canStopTurn(thread),
    ...(stopping && { steerable: false as const, steerReason: stopping }),
  };
  const readyNow = (why?: "focus" | "words") => {
    if (!thread || !hosted || blocked || block || thread.activity === "running") return;
    if (why === "focus" && withOthers(thread)) return;
    const { choice, mode, permission } = settings;
    ready.mutate({ id: thread.id, settings: { ...(choice && { agent: choice.agent, model: choice.model, effort: choice.effort ?? null }), mode, permissionMode: permission } });
  };
  if (!hosted) return { hosted, notice: moveCard, blocked: null, limits, shown: (error) => error };
  Object.assign(limits, together);
  return {
    hosted,
    notice: moveCard ?? hostedNotice({ block: block && !blocked ? block : null, ...reachableBlock(thread, writeBlock), composer, draft }),
    blocked: blocked ?? block?.words ?? null,
    limits,
    shown: (error) => (error === block?.words ? undefined : error),
    onReady: readyNow,
  };
}

/** A place that can't be reached says so in the composer's own words; no card offers a move it can't take. */
function reachableBlock(thread: ThreadSummary | null, writeBlock: string | null): { writeBlock: string | null; thread: ThreadSummary | null } {
  return placeUnreachable(thread) ? { writeBlock: null, thread: null } : { writeBlock, thread };
}

/**
 * The card for a block the account fixes, else for the server's word that this person cannot run the agent here, with
 * the move that releases a handoff where the server lets this reader make it: Retry save, or Stop for the command that
 * holds the turn.
 */
function hostedNotice({
  block,
  writeBlock,
  thread,
  composer,
  draft,
}: {
  block: { words: string; action: SendBlockAction | null } | null;
  writeBlock: string | null;
  thread: ThreadSummary | null;
  composer: RefObject<ComposerHandle | null>;
  draft: string;
}): ReactNode {
  if (block) return <SendBlockCard words={block.words} action={block.action} />;
  const handoff = handoffCard(thread);
  // A note already staged in the composer is posted from there; the card offers it no second time.
  const staged = handoff?.action?.kind === "note" && draft.includes(draftOfNote(handoff.action.note));
  if (handoff?.action && thread && !staged) return <HandoffCard threadId={thread.id} words={handoff.words} action={handoff.action} composer={composer} />;
  if (handoff && staged) return <SendBlockCard words={handoff.words} action={null} />;
  if (!writeBlock) return null;
  return <SendBlockCard words={handoff?.words ?? writeBlock} action={null} />;
}

/**
 * A handoff the reader can release: Retry save asks the server to save the thread's work again, Stop ends the
 * previous sender's commands that keep the thread from moving, and Stop work ends the work that reports back. A reader
 * with none of them tags the person who can: the server's note opens in the composer, to post as it is or in their own
 * words. None of them starts a turn.
 */
function HandoffCard({ threadId, words, action, composer }: { threadId: string; words: string; action: HandoffAction; composer: RefObject<ComposerHandle | null> }) {
  const retry = useRpcMutation("threads.retrySave");
  const stop = useRpcMutation("threads.stopCommand");
  const stopWork = useRpcMutation("threads.stopWork");
  const pending = retry.isPending || stop.isPending || stopWork.isPending;
  const release = async () => {
    if (action.kind === "note") return composer.current?.note(action.note);
    if (action.kind === "retry-save") return retry.mutate({ threadId });
    if (action.kind === "stop-work") return stopWork.mutate({ threadId });
    for (const commandId of action.commandIds) await stop.mutateAsync({ id: threadId, commandId }).catch(() => undefined);
  };
  const label = handoffLabel(action);
  return (
    <section role="status" aria-label="OpenOrc Cloud" data-plane className={cn(card, "flex flex-wrap items-center justify-between gap-x-3")}>
      <div className="py-1.5 text-ink">{retry.error?.message ?? stop.error?.message ?? stopWork.error?.message ?? words}</div>
      <Button variant="secondary" disabled={pending} onClick={() => void release()}>
        {label}
      </Button>
    </section>
  );
}

/**
 * The card above the composer: why a send cannot start a turn on OpenOrc Cloud, and at the row's end a key to the
 * Settings section with the way on. A key, since the column's one ink pill is the send.
 */
function SendBlockCard({ words, action }: { words: string; action: SendBlockAction | null }) {
  const navigate = useRouter((s) => s.navigate);
  return (
    <section role="status" aria-label="OpenOrc Cloud" data-plane className={cn(card, "flex flex-wrap items-center justify-between gap-x-3")}>
      <div className="py-1.5 text-ink">{words}</div>
      {action ? (
        <Button variant="secondary" onClick={() => navigate({ view: "settings", section: action.section })}>
          {action.label}
        </Button>
      ) : null}
    </section>
  );
}

/**
 * Why nothing can be written in the thread now: it is moving between this computer and the cloud, or the server (from
 * one that predates working together: its starter) says this person may not write in it.
 */
function readOnlyReason(thread: ThreadSummary | null, writeBlock: string | null): string | null {
  return movingHold(thread?.moving, machine) ?? (threadTogether(thread) ? writeBlock : threadReadOnlyReason(thread));
}

/** Why the thread's last move between this computer and the cloud stopped, with the move again; null otherwise. */
function moveFailedCard(thread: ThreadSummary | null): ReactNode {
  return thread?.moving?.failed ? <MoveFailedCard thread={thread} moving={{ ...thread.moving, failed: thread.moving.failed }} /> : null;
}

/**
 * Why the thread's last move between this computer and OpenOrc Cloud stopped, where it left it, with the move again. A
 * folder here that stopped it is named as the person reads paths, the whole path on demand, and opens in the file
 * manager.
 */
function MoveFailedCard({ thread, moving }: { thread: ThreadSummary; moving: ThreadMoving & { failed: string } }) {
  const dismiss = useRpcMutation("threads.moveDismiss");
  const offer = useCloudMove(thread);
  const start = useStartCloudMove();
  const folder = moving.folder;
  return (
    <section role="status" aria-label="Move" data-plane className={cn(card, "flex flex-wrap items-center justify-between gap-x-3")}>
      <div className="min-w-0 py-1.5">
        <div className="text-ink break-words">
          Didn't move to {moving.to === "cloud" ? "OpenOrc Cloud" : thisComputer}. {dismiss.error?.message ?? moving.failed}
        </div>
        {folder ? (
          <TextButton tone="muted" className="max-w-full truncate text-sm" data-tip={folder} aria-label={`${revealLabel()}: ${folder}`} onClick={() => window.openorc.revealFile(folder)}>
            {homeRelative(folder)}
          </TextButton>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" disabled={dismiss.isPending} onClick={() => dismiss.mutate({ threadId: thread.id })}>
          Dismiss
        </Button>
        <Button variant="secondary" disabled={!offer} onClick={() => start(thread.id, offer)}>
          Try again
        </Button>
      </div>
    </section>
  );
}
