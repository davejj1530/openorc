import { accountsToContinueWith, canContinueWithAnother, CONTINUE_PROMPT, RESTART_PROMPT, usageResetLabel, type SubmitRequest } from "@openorc/client";
import { DEFAULT_CLAUDE_ACCOUNT, harnessShortName, isHarnessId, type ThreadSummary } from "@openorc/protocol";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useHostClient, useRpc } from "../client";
import { failureMessage } from "../failure";
import { UsageRing } from "../settings/UsageRing";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { continueChoices, type ContinueChoice } from "./continue-choices";

interface RecoveryProps {
  thread: ThreadSummary;
  request: Omit<SubmitRequest, "now">;
  /** The phone cannot send right now, as the composer says. */
  disabled: boolean;
  onSent: () => void;
}

/** What stopped the conversation, and the fresh start that gets it going again, where one would help. */
function stoppedWords({ agent, session }: ThreadSummary, account: string | undefined): { title: string; detail: string | null; restart: string | null } {
  const name = isHarnessId(agent) ? harnessShortName(agent) : "The agent";
  if (session.status === "lost") return { title: `${name} no longer has this session`, detail: session.message, restart: "Start a fresh session with a handoff" };
  if (session.recovery?.kind === "usage") return { title: `${account ?? name} reached its limit`, detail: session.message, restart: null };
  if (session.recovery?.kind === "sign_in") return { title: `${account ?? name} is signed out`, detail: "Sign in again on your Mac.", restart: null };
  return { title: "The last turn failed", detail: session.message, restart: "Retry with a fresh session" };
}

function choiceValue({ left, limited }: ContinueChoice, now: number): string | null {
  if (limited) return limited.resetsAt ? usageResetLabel(limited.resetsAt, now) : "At its limit";
  return left === null ? null : `${Math.round(left)}% left`;
}

/** One account to go on with: the share of its plan left, and it turns while the conversation starts there. */
function AccountChoice({ choice, now, going, disabled, onPress }: { choice: ContinueChoice; now: number; going: boolean; disabled: boolean; onPress: () => void }) {
  const value = choiceValue(choice, now);
  const off = disabled || Boolean(choice.limited);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[`Continue with ${choice.account.name}`, value].filter(Boolean).join(", ")}
      accessibilityState={{ disabled: off, busy: going }}
      disabled={off}
      onPress={onPress}
      className="min-h-touch flex-row items-center gap-3 rounded-2xl bg-surface-2 px-3 active:bg-surface-3"
    >
      {going ? <Spinner size={16} /> : <UsageRing left={choice.limited ? 0 : choice.left} stale={false} />}
      <Text numberOfLines={1} className={cn("min-w-0 flex-1 text-md", off && "text-ink-4")}>
        {choice.account.name}
      </Text>
      {value ? <Text className="text-sm tabular-nums text-ink-3">{value}</Text> : null}
    </Pressable>
  );
}

/**
 * Over the composer while a conversation cannot go on as it was: what stopped it, in the agent's words, and the way
 * back. A turn stopped on one Claude account goes on with another, the one with the most left first, and its session
 * goes with it; a lost session or a failed turn starts fresh with a handoff, as on the Mac. Typing a message still
 * resumes, so the card steps aside while the person writes.
 */
function Stopped({ thread, request, disabled, onSent }: RecoveryProps) {
  const [going, setGoing] = useState<string | null>(null);
  // A second tap can land before the first start renders, as on Send.
  const inFlight = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  const submitter = useHostClient().useSubmit();
  const offered = canContinueWithAnother(thread) && request.choice?.agent === "claude";
  const list = useRpc("claude.accounts.list", {}, { enabled: canContinueWithAnother(thread) });
  // From the cached list: a project that uses only some accounts goes on with one of those.
  const project = useRpc("projects.list", {}, { enabled: offered }).data?.find((each) => each.id === thread.projectId);
  const limits = useRpc("providers.limits", {}, { enabled: offered, staleTime: 60_000, gcTime: Infinity });
  const now = Date.now();
  const accounts = list.data?.accounts ?? [];
  const choices = offered ? continueChoices(accountsToContinueWith(thread, accounts, project), limits.data ?? [], now) : [];
  const own = accounts.find((account) => account.id === (thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT))?.name;
  const words = stoppedWords(thread, thread.agent === "claude" && accounts.length > 1 ? own : undefined);
  const start = (key: string, how: Pick<SubmitRequest, "restart" | "claudeAccountId">, prompt: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    haptic.tap();
    setGoing(key);
    setFailure(null);
    submitter
      .submit({ ...request, now: false, ...how }, { text: prompt, attachments: [] })
      .then(() => {
        haptic.confirm();
        onSent();
      })
      .catch((error: unknown) => {
        haptic.fail();
        setFailure(failureMessage(error));
      })
      .finally(() => {
        inFlight.current = false;
        setGoing(null);
      });
  };
  const off = disabled || going !== null;
  return (
    <View className="gap-2 rounded-3xl bg-surface px-4 pb-4 pt-3.5">
      <Text accessibilityRole="header" className="text-md">
        {words.title}
      </Text>
      {words.detail ? (
        <Text numberOfLines={3} className="text-sm text-ink-3">
          {words.detail}
        </Text>
      ) : null}
      {choices.length ? (
        <View className="gap-1.5 pt-1">
          <Text className="text-sm text-ink-4">Continue with</Text>
          {choices.map((choice) => (
            <AccountChoice
              key={choice.account.id}
              choice={choice}
              now={now}
              going={going === choice.account.id}
              disabled={off}
              onPress={() => start(choice.account.id, { claudeAccountId: choice.account.id }, CONTINUE_PROMPT)}
            />
          ))}
        </View>
      ) : null}
      {words.restart ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: off, busy: going === "restart" }}
          disabled={off}
          onPress={() => start("restart", { restart: true }, RESTART_PROMPT)}
          className="h-control-md flex-row items-center justify-center gap-2 self-start rounded-full bg-surface-2 px-4 active:bg-surface-3"
        >
          {going === "restart" ? <Spinner size={14} /> : null}
          <Text className={cn("text-sm text-ink-2", off && "text-ink-4")}>{words.restart}</Text>
        </Pressable>
      ) : null}
      {failure ? (
        <Text accessibilityRole="alert" className="text-sm text-bad">
          {failure}
        </Text>
      ) : null}
    </View>
  );
}

export function SessionRecovery(props: RecoveryProps) {
  const { status } = props.thread.session;
  return status === "error" || status === "lost" ? <Stopped {...props} /> : null;
}
