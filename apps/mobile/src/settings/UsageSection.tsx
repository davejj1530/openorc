import { allowanceState, usageResetLabel } from "@openorc/client";
import { percentLeft, type AllowanceWindow, type PlanLimits } from "@openorc/protocol";
import { Fragment } from "react";
import { View } from "react-native";
import { RefreshCw } from "../generated/icons";
import { cn } from "../ui/cn";
import { HarnessLogo } from "../ui/HarnessLogo";
import { ListPressable } from "../ui/ListPressable";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { Card, Divider, RowLines, rowClass, Section } from "./parts";
import { useUsage, type Usage } from "./use-usage";
import { UsageRing } from "./UsageRing";

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const emptyWords: Record<PlanLimits["status"], string> = {
  available: "No limits reported",
  unavailable: "No limits reported",
  disconnected: "Not signed in",
  error: "Couldn’t read usage",
};

/** One limit: its ring, its label and the share left on one line, and when it resets under them. Only the share warns. */
function LimitRow({ window, now }: { window: AllowanceWindow; now: number }) {
  const stale = allowanceState(window, now).stale;
  const left = percentLeft(window);
  const reset = stale ? `Out of date · reported ${time.format(window.observedAt)}` : usageResetLabel(window.resetsAt, now);
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
function AccountCard({ limits, now, dim }: { limits: PlanLimits; now: number; dim: boolean }) {
  return (
    <Card>
      <View className={cn(dim && "opacity-50")}>
        <View accessible accessibilityRole="header" accessibilityLabel={[limits.name, limits.plan].filter(Boolean).join(", ")} className={rowClass}>
          <RowLines lead={<HarnessLogo agent={limits.provider} size={16} />} label={limits.name} trailing={limits.plan ? <Text className="text-sm text-ink-4">{limits.plan}</Text> : null} />
        </View>
        {limits.windows.length === 0 ? (
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
              <LimitRow window={window} now={now} />
            </Fragment>
          ))
        )}
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

/** What stands in for the cards: a read on its way, the host it waits for, or a host with no limits at all. */
function NoCards({ words, reading }: { words: string; reading: boolean }) {
  return (
    <Card>
      <View className={rowClass}>
        <RowLines lead={reading ? <Spinner size={16} /> : null} label={words} labelClassName="text-ink-4" />
      </View>
    </Card>
  );
}

function noCardsWords({ state, live, hostName }: Pick<Usage, "state" | "live" | "hostName">): string {
  if (state === "ready") return "No limits reported";
  return live ? "Reading usage" : `Waiting for ${hostName}`;
}

/**
 * The Claude and Codex limits of the shown host's group, read only, as the desktop's Settings > Usage shows them. While
 * neither host is connected the last read stays, dimmed and held still, with the time it was read under the label.
 */
export function UsageSection() {
  const { accounts, state, live, readAt, now, hostName, retry } = useUsage();
  const none = state === "failed" && live ? <ReadFailed retry={retry} /> : <NoCards words={noCardsWords({ state, live, hostName })} reading={state === "loading" && live} />;
  return (
    <Section title="Usage" note={live || readAt === null ? null : `Last read at ${time.format(readAt)}`}>
      {accounts.length > 0 ? (
        <View className="gap-3">
          {accounts.map((limits) => (
            <AccountCard key={limits.id} limits={limits} now={now} dim={!live} />
          ))}
        </View>
      ) : (
        none
      )}
    </Section>
  );
}
