import { memo } from "react";
import { View } from "react-native";
import { OpenOrcMark } from "../ui/OpenOrcMark";
import { useColors } from "../ui/mode";
import { FIXED_HEIGHT } from "./rows";

/**
 * Whoever is on the other end, at the tail of the conversation. It rests between turns and stirs while one runs, so
 * the conversation always ends in the agent rather than in whatever step happened last.
 */
export const AgentPresence = memo(function AgentPresence({ working }: { working: boolean }) {
  const palette = useColors();
  return (
    <View
      className="-ml-2.5 items-center justify-center"
      style={{ width: FIXED_HEIGHT.presence, height: FIXED_HEIGHT.presence }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <OpenOrcMark size={22} color={working ? palette["content-ink"] : palette["ink-3"]} working={working} />
    </View>
  );
});
