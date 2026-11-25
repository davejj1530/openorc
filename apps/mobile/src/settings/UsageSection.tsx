import { creditBalanceLabel, allowanceState, usageResetLabel } from "@openorc/client";
import { percentLeft, type AllowanceWindow, type PlanLimits } from "@openorc/protocol";
import { Fragment } from "react";
import { View } from "react-native";
import { RefreshCw } from "../generated/icons";
import { cn } from "../ui/cn";
import { HarnessLogo } from "../ui/HarnessLogo";
import { ListPressable } from "../ui/ListPressable";
import { WorkingMark } from "../ui/StateMark";
import { Text } from "../ui/Text";
import { Card, Divider, RowLines, rowClass, Section } from "./parts";
import { useCloudLimits, useUsage, type Usage } from "./use-usage";
import { UsageRing } from "./UsageRing";

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const emptyWords: Record<PlanLimits["status"], string> = {
  available: "No limits reported",
  unavailable: "No limits reported",
  disconnected: "Not signed in",
  error: "Couldn’t read usage",
};

/** Under a limit: when it resets; for a reading of OpenOrc Cloud's, when it was taken; out of date, that with why. */
function resetWords(window: AllowanceWindow, now: number, stale: boolean, turnRead: boolean): string {
  const reported = time.format(window.observedAt);
  if (stale) return `Out of date · reported ${reported}`;
  return turnRead ? `Reported ${reported}` : usageResetLabel(window.resetsAt, now);
}

/**
 * One limit: its ring, its label and the share left on one line, and when it resets under them. Only the share warns.
 * A reading of OpenOrc Cloud's (`turnRead`) comes only from a turn on the account, so it says when it was taken and is
 * never out of date by age, as the desktop's Settings shows it.
 */
function LimitRow({ window, now, outdated, turnRead }: { window: AllowanceWindow; now: number; outdated: boolean; turnRead: boolean }) {
  const stale = outdated || (!turnRead && allowanceState(window, now).stale);
  const left = percentLeft(window);
  const reset = resetWords(window, now, stale, turnRead);
  const value = left === null ? "Not reported" : `${Math.round(left)}% left`;
  return (
    <View accessible accessibilityLabel={[window.label, value, reset].filter(Boolean).join(", ")} className={rowClass}>
      <RowLines
        lead={<UsageRing left={left} stale={stale} />}
        label={window.label}
        labelClassName="text-ink-3"
        detail={reset}
        trailing={<Text className={cn("text-md tabular-nums text-ink", (window.exhausted || stale) && "text-warn", left === null && "text-ink-4")}>{value}</Text>}
      />
    </View>
  );
}

/** One account: its harness mark, name and plan, then a row per limit, or why there are none. `dim` fades the rows, not the card. */
function AccountCard({ limits, now, dim, turnRead }: { limits: PlanLimits; now: number; dim: boolean; turnRead: boolean }) {
  return (
    <Card>
      <View className={cn(dim && "opacity-50")}>
        <View accessible accessibilityRole="header" accessibilityLabel={[limits.name, limits.plan].filter(Boolean).join(", ")} className={rowClass}>
          <RowLines lead={<HarnessLogo agent={limits.provider} size={16} />} label={limits.name} trailing={limits.plan ? <Text className="text-sm text-ink-4">{limits.plan}</Text> : null} />
        </View>
        {limits.windows.length === 0 && !limits.credits?.length ? (
          <>
            <Divider />
            <View className={rowClass}>
              <RowLines label={emptyWords[limits.status]} labelClassName="text-ink-4" />
            </View>
          </>
        ) : (
          limits.windows.map((window) => (
            <Fragment key={window.id}>
              <Divider />
              <LimitRow window={window} now={now} outdated={limits.status === "error" || limits.status === "disconnected"} turnRead={turnRead} />
            </Fragment>
          ))
        )}
        {limits.credits?.map((credit, index) => (
          <Fragment key={`${credit.label}:${index}`}>
            <Divider />
            <View className={rowClass}>
              <RowLines label={credit.label} labelClassName="text-ink-3" trailing={<Text className="text-md tabular-nums text-ink">{creditBalanceLabel(credit)}</Text>} />
            </View>
          </Fragment>
        ))}
      </View>
    </Card>
  );
}

/** A read that failed with nothing to show, and a way to ask again. */
function ReadFailed({ retry }: { retry: () => void }) {
  return (
    <Card>
      <ListPressable accessibilityRole="button" onPress={retry} className={cn(rowClass, "active:bg-surface-2")}>
        <RowLines lead={<RefreshCw size={16} className="text-ink-4" />} label="Couldn’t read usage" labelClassName="text-ink-3" detail="Try again" />
      </ListPressable>
    </Card>
  );
}

/** What stands in for the cards: a read on its way, the Mac it waits for, or a Mac with no limits at all. */
function NoCards({ words, reading }: { words: string; reading: boolean }) {
  return (
    <Card>
      <View className={rowClass}>
        <RowLines lead={reading ? <WorkingMark size={16} /> : null} label={words} labelClassName="text-ink-4" />
      </View>
    </Card>
  );
}

function noCardsWords({ state, live, hostName }: Pick<Usage, "state" | "live" | "hostName">): string {
  if (state === "ready") return "No limits reported";
  return live ? "Reading usage" : `Waiting for ${hostName}`;
}

/**
 * The shown Mac's account limits, then the person's sign-ins on OpenOrc Cloud, read only, as the desktop's Settings >
 * Usage shows them. While the phone is not
 * connected the last read stays, dimmed and held still, with the time it was read under the label.
 */
export function UsageSection() {
  const { accounts: mac, state, live, readAt, now, hostName, retry } = useUsage();
  const cloud = useCloudLimits(live);
  const accounts = [...mac.map((limits) => ({ limits, turnRead: false })), ...cloud.map((limits) => ({ limits, turnRead: true }))];
  const none = state === "failed" && live ? <ReadFailed retry={retry} /> : <NoCards words={noCardsWords({ state, live, hostName })} reading={state === "loading" && live} />;
  return (
    <Section title="Usage" note={live || readAt === null ? null : `Last read at ${time.format(readAt)}`}>
      {accounts.length > 0 ? (
        <View className="gap-3">
          {accounts.map(({ limits, turnRead }) => (
            <AccountCard key={limits.id} limits={limits} now={now} dim={!live} turnRead={turnRead} />
          ))}
        </View>
      ) : (
        none
      )}
    </Section>
  );
}
