import { router } from "expo-router";
import { Fragment, useState, type ReactNode } from "react";
import { Alert } from "react-native";
import { alerts, link, useSavedMacs } from "../client";
import type { LinkState, MacName } from "../connection/manager";
import type { SavedMac } from "../connection/saved-macs";
import { useLinkWords } from "../connection/use-link-words";
import { Laptop, Plus, RefreshCw } from "../generated/icons";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { LinkDot } from "../ui/LinkDot";
import { ListPressable } from "../ui/ListPressable";
import { Spinner } from "../ui/Spinner";
import { swipeAccessibility, type SwipeAction } from "../ui/swipe";
import { SwipeRow } from "../ui/SwipeRow";
import { Card, Divider, RowLines, rowClass, Section } from "./parts";

type Paired = Exclude<LinkState, { kind: "unpaired" }>;

const pressable = cn(rowClass, "active:bg-surface-2");

function confirmForget(mac: MacName): void {
  Alert.alert(`Forget ${mac.name}?`, "To connect again, scan a new code on your Mac.", [
    { text: "Cancel", style: "cancel" },
    { text: "Forget", style: "destructive", onPress: () => void alerts.forget(mac.id) },
  ]);
}

const forgetting = (mac: MacName): SwipeAction => ({ label: "Forget", tone: "bad", run: () => confirmForget(mac) });

/**
 * Shows a saved Mac on Home and goes back there, where it connects; the shown Mac only goes Home. The layout's
 * leaveOnMacChange also goes Home; a second dismissTo where Home already shows does nothing, where back would find
 * nothing to close.
 */
function show(mac: MacName): void {
  haptic.select();
  link.select(mac.id);
  router.dismissTo("/");
}

/** One saved Mac, which shows it on a tap and forgets it from a swipe or VoiceOver's actions. */
function MacRow({ mac, shown, label, children }: { mac: MacName; shown: boolean; label: string; children: ReactNode }) {
  const forget = forgetting(mac);
  return (
    <SwipeRow id={mac.id} trailing={forget}>
      <ListPressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: shown }} {...swipeAccessibility([forget])} onPress={() => show(mac)} className={pressable}>
        {children}
      </ListPressable>
    </SwipeRow>
  );
}

/** The Mac Home shows: the dot on its name's line, and what the phone knows about reaching it, in full. */
function ShownMac({ state }: { state: Paired }) {
  const words = useLinkWords(state);
  return (
    <MacRow mac={state.mac} shown label={`${state.mac.name}, ${words.spoken}`}>
      <RowLines lead={<LinkDot tone={words.tone} />} label={state.mac.name} detail={words.detail} />
    </MacRow>
  );
}

function OtherMac({ mac }: { mac: SavedMac }) {
  return (
    <MacRow mac={mac} shown={false} label={mac.name}>
      <RowLines lead={<Laptop size={16} className="text-ink-4" />} label={mac.name} labelClassName="text-ink-3" />
    </MacRow>
  );
}

/**
 * Tries the shown Mac now instead of at the next backoff step. It stays while the phone is not connected, whatever
 * the retries in between do, and turns only for the attempt the person asked for.
 */
function TryAgain() {
  const [trying, setTrying] = useState(false);
  const tryNow = () => {
    setTrying(true);
    void link.retry().finally(() => setTrying(false));
  };
  return (
    <ListPressable accessibilityRole="button" accessibilityState={{ disabled: trying }} disabled={trying} onPress={tryNow} className={pressable}>
      <RowLines lead={trying ? <Spinner size={16} /> : <RefreshCw size={16} className="text-ink-4" />} label="Try again" labelClassName="text-ink-3" />
    </ListPressable>
  );
}

function PairRow({ label }: { label: string }) {
  return (
    <ListPressable accessibilityRole="button" onPress={() => router.push("/pair")} className={pressable}>
      <RowLines lead={<Plus size={16} className="text-ink-4" />} label={label} labelClassName="text-ink-3" />
    </ListPressable>
  );
}

/**
 * The Macs this phone paired with: the one Home shows and how it is reached, a way to try again while it is not, the
 * others to switch to, and pairing another. With none, pairing.
 */
export function MacSection({ state }: { state: LinkState }) {
  const macs = useSavedMacs();
  if (state.kind === "unpaired")
    return (
      <Section title="Mac">
        <Card>
          <PairRow label="Pair a Mac" />
        </Card>
      </Section>
    );
  const others = macs.filter((mac) => mac.id !== state.mac.id);
  return (
    <Section title="Mac">
      <Card>
        <ShownMac state={state} />
        {state.kind === "connected" ? null : (
          <>
            <Divider />
            <TryAgain />
          </>
        )}
        {others.map((mac) => (
          <Fragment key={mac.id}>
            <Divider />
            <OtherMac mac={mac} />
          </Fragment>
        ))}
        <Divider />
        <PairRow label="Pair another Mac" />
      </Card>
    </Section>
  );
}

/** Forgetting the shown Mac, last on the sheet and on its own, confirmed first. */
export function ForgetMac({ mac }: { mac: MacName }) {
  return (
    <Card>
      <ListPressable accessibilityRole="button" onPress={() => confirmForget(mac)} className={pressable}>
        <RowLines label={`Forget ${mac.name}`} labelClassName="text-bad" />
      </ListPressable>
    </Card>
  );
}
