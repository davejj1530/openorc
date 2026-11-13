import { threadSendBlock, type SendBlock } from "@openorc/client";
import { HOSTED_AGENTS, type HarnessId, type PermissionPreset, type RunMode, type ThreadSummary } from "@openorc/protocol";
import type { ReactNode } from "react";
import { useRpc, useRpcMutation } from "../lib/client";
import { useRouter } from "../lib/router";
import type { ModelChoice } from "./ModelPicker";
import { Button } from "./ui";

const card = "rounded-xl bg-surface px-3.5 py-1.5 text-base";
const FILES = "Files can't be sent to OpenOrc Cloud yet.";

/** What a cloud thread's composer leaves out: what OpenOrc Cloud does not take yet, absent or disabled with its reason. */
export interface CloudComposerLimits {
  accounts?: undefined;
  onCompact?: undefined;
  attachmentsDisabledReason: string;
  modelLimits: { harnesses: readonly HarnessId[]; fast: false };
}

const CLOUD_LIMITS: CloudComposerLimits = { accounts: undefined, onCompact: undefined, attachmentsDisabledReason: FILES, modelLimits: { harnesses: HOSTED_AGENTS, fast: false } };

/**
 * What an OpenOrc Cloud thread adds to its conversation, and nothing for any other thread:
 *   notice     the card above the composer when a send cannot start a turn, with its words and its way on
 *   blocked    the same words, as the reason Send is disabled
 *   limits     the composer's controls a cloud thread leaves out, spread over its props
 *   onReady    the composer's ready signal: writing begins, so the thread is made ready for the message
 *   shown      the composer's error line, without a refusal the card already says in the same words
 *   hosted     a cloud thread runs elsewhere, so this Mac's skills and connectors are not offered in it
 *
 * The block is derived once from `account.status`, the read Settings makes, so when a sign-in or a purchase lands the
 * card goes by itself. The thread is made ready when the message box takes focus, and when a draft starts from empty;
 * the core asks the server at most once a minute and never while the account says a turn cannot start.
 */
export function useHostedComposer(
  thread: ThreadSummary | null,
  settings: { choice: ModelChoice | null; mode: RunMode; permission: PermissionPreset },
): {
  hosted: boolean;
  notice: ReactNode;
  blocked: string | null;
  limits: CloudComposerLimits | object;
  onReady?: () => void;
  shown: (error: string | null | undefined) => string | null | undefined;
} {
  const hosted = thread?.owner?.brain === "hosted";
  const account = useRpc("account.status", {}, { enabled: hosted });
  const ready = useRpcMutation("threads.ready");
  const agent = settings.choice?.agent ?? thread?.agent ?? "";
  const block = threadSendBlock(thread, account.data, { agent, model: settings.choice?.model ?? thread?.model ?? null });
  const readyNow = () => {
    if (!thread || !hosted || block || thread.activity === "running") return;
    const { choice, mode, permission } = settings;
    ready.mutate({ id: thread.id, settings: { ...(choice && { agent: choice.agent, model: choice.model, effort: choice.effort ?? null }), mode, permissionMode: permission } });
  };
  if (!hosted) return { hosted, notice: null, blocked: null, limits: {}, shown: (error) => error };
  return {
    hosted,
    notice: block ? <SendBlockCard block={block} /> : null,
    blocked: block?.words ?? null,
    limits: CLOUD_LIMITS,
    shown: (error) => (error === block?.words ? undefined : error),
    onReady: readyNow,
  };
}

/** The card above the composer: why a send cannot start a turn on OpenOrc Cloud, and the Settings section with the way on. */
function SendBlockCard({ block }: { block: SendBlock }) {
  const navigate = useRouter((s) => s.navigate);
  const { action } = block;
  return (
    <section role="status" aria-label="OpenOrc Cloud" data-plane className={card}>
      <div className="py-1.5 text-ink">{block.words}</div>
      {action ? (
        <div className="flex flex-wrap items-center gap-2 pb-1.5">
          <Button variant="primary" onClick={() => navigate({ view: "settings", section: action.section })}>
            {action.label}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
