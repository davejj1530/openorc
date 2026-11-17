import { router } from "expo-router";
import type { ComponentType } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check } from "../generated/icons";
import { haptic } from "../ui/haptics";
import type { IconProps } from "../ui/icon";
import { Text } from "../ui/Text";
import { useSpaces } from "../spaces/use-spaces";
import { chooseFilter, chooseOwnership, FILTER_CHOICES, filterChoice, hiddenIn, ownershipIn, toggleWorkspace, useHomeFilter, type Ownership } from "./filter";
import { projectMark } from "./HomeHeading";
import { useListScope } from "./use-home-items";

const OWNERSHIP: readonly { value: Ownership; label: string }[] = [
  { value: "mine", label: "Mine" },
  { value: "everyone", label: "Everyone’s" },
];

/** One choice of the sheet: its mark, its words, and a tick while it holds. */
function Choice({ label, checked, icon: Icon, role, onPress }: { label: string; checked: boolean; icon?: ComponentType<IconProps>; role: "radio" | "checkbox"; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={{ checked }}
      onPress={() => {
        haptic.select();
        onPress();
      }}
      className="min-h-touch flex-row items-center gap-3 rounded-md px-3 active:bg-surface-2"
    >
      {Icon ? <Icon size={18} className="text-ink-3" /> : null}
      <Text numberOfLines={1} className="flex-1 text-md">
        {label}
      </Text>
      {checked ? <Check size={16} /> : null}
    </Pressable>
  );
}

const Rule = () => <View className="mx-3 my-2 bg-line" style={{ height: StyleSheet.hairlineWidth }} />;

/**
 * What Home lists, as the desktop sidebar's filter offers it: in an organization the person's own threads or
 * everyone's; every thread or the pinned ones; and a tick for each workspace, in the list's order. Choices keep the
 * sheet open, as ticking keeps the desktop's menu open, and the sheet is as tall as what it holds.
 */
export function FilterSheet() {
  const insets = useSafeAreaInsets();
  const filter = useHomeFilter();
  const current = filterChoice(filter);
  const account = useSpaces();
  const organization = account.state === "ready" && account.current.kind === "organization";
  const { scope, key } = useListScope();
  const hidden = hiddenIn(filter, key);
  return (
    <View className="gap-0.5 bg-bg px-5 pt-6" style={{ paddingBottom: insets.bottom + 16 }} onAccessibilityEscape={() => router.back()}>
      <Text accessibilityRole="header" className="mb-2 px-3 text-xl">
        Show
      </Text>
      {organization ? (
        <>
          {OWNERSHIP.map(({ value, label }) => (
            <Choice key={value} role="radio" label={label} checked={ownershipIn(filter, key) === value} onPress={() => chooseOwnership(key, value)} />
          ))}
          <Rule />
        </>
      ) : null}
      {FILTER_CHOICES.map(({ choice, label }) => (
        <Choice key={choice} role="radio" label={label} checked={choice === current} onPress={() => chooseFilter(choice)} />
      ))}
      {scope.groups.length ? <Rule /> : null}
      {scope.groups.map((group) => (
        <Choice key={group.id} role="checkbox" label={group.name} icon={projectMark(group)} checked={!hidden.includes(group.id)} onPress={() => toggleWorkspace(key, group.id)} />
      ))}
    </View>
  );
}
