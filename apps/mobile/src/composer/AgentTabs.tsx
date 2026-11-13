import { harnessShortName, type AgentKind } from "@openorc/protocol";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View, type ScrollViewInstance } from "react-native";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { HarnessLogo } from "../ui/HarnessLogo";

/** Logos keep their touch targets even when the full agent list needs to scroll. */
export function AgentTabs({ agents, shown, onShow }: { agents: AgentKind[]; shown: AgentKind; onShow: (agent: AgentKind) => void }) {
  const scroll = useRef<ScrollViewInstance>(null);
  const [width, setWidth] = useState(0);
  const [layouts, setLayouts] = useState<Record<string, { x: number; width: number }>>({});
  const selected = layouts[shown];
  useEffect(() => {
    if (selected) scroll.current?.scrollTo({ x: Math.max(0, selected.x + selected.width / 2 - width / 2), animated: false });
  }, [width, selected]);
  return (
    <ScrollView
      ref={scroll}
      horizontal
      showsHorizontalScrollIndicator={false}
      className="grow-0 rounded-full bg-surface-2"
      contentContainerStyle={{ minWidth: "100%" }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <View accessibilityRole="tablist" accessibilityLabel="Coding agents" className="flex-1 flex-row p-0.75">
        {agents.map((agent) => (
          <Pressable
            key={agent}
            accessibilityRole="tab"
            accessibilityLabel={harnessShortName(agent)}
            accessibilityState={{ selected: agent === shown }}
            onLayout={(event) => {
              const { x, width } = event.nativeEvent.layout;
              setLayouts((previous) => (previous[agent]?.x === x && previous[agent]?.width === width ? previous : { ...previous, [agent]: { x, width } }));
            }}
            onPress={() => {
              if (agent === shown) return;
              haptic.select();
              onShow(agent);
            }}
            className={cn("min-h-touch min-w-touch flex-1 items-center justify-center rounded-full active:bg-surface-3", agent === shown && "bg-surface")}
          >
            <HarnessLogo agent={agent} size={22} />
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}
