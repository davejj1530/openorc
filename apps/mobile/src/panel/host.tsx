import { router, Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import { createContext, memo, useContext, useMemo, type ComponentProps, type ComponentType } from "react";
import { Host, Button, Menu, RNHostView } from "@expo/ui/swift-ui";
import { accessibilityLabel } from "@expo/ui/swift-ui/modifiers";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PanelTitle } from "../changes/PanelTitle";
import { ChevronDown, ChevronLeft, MoreHorizontal, X } from "../generated/icons";
import { cn } from "../ui/cn";
import type { IconProps } from "../ui/icon";
import { useMode } from "../ui/mode";
import { pane, type PanelRoute } from "./pane";

/** A panel screen's place in the pane beside the thread. Absent, the screen is a route in the stack. */
export interface PaneScreen {
  route: PanelRoute;
  /** It is the pane's first screen, which closes the pane; a later one goes back. */
  first: boolean;
  /** It is the screen in front. The ones under it stay as they were left. */
  front: boolean;
}

export const PaneScreenContext = createContext<PaneScreen | null>(null);

/** What a panel screen shows: the pane's, or its route's in the stack. */
export function usePanelParams<Params extends Record<string, string | undefined>>(): Params {
  const local = useLocalSearchParams();
  const screen = useContext(PaneScreenContext);
  return (screen ? screen.route.params : local) as Params;
}

/** Whether a panel screen is the one in view, for what it reads only while watched. */
export function usePanelFocused(): boolean {
  const focused = useIsFocused();
  const screen = useContext(PaneScreenContext);
  return screen ? screen.front : focused;
}

/** How a panel screen moves on: to another over it, or to something else of its own kind, wherever it stands. */
export function usePanelNav(): { open: (route: PanelRoute) => void; setParams: (params: Record<string, string>) => void } {
  const beside = useContext(PaneScreenContext) !== null;
  return useMemo(
    () => ({
      open: (route) => (beside ? pane.push(route) : router.push({ pathname: `/${route.name}`, params: route.params })),
      setParams: (params) => (beside ? pane.setParams(params) : router.setParams(params)),
    }),
    [beside],
  );
}

type Symbol = NonNullable<ComponentProps<typeof Button>["systemImage"]>;

/** The glyphs a panel's bar buttons wear: iOS's in the stack's header, the app's own in the pane's bar. */
const faces = {
  "chevron.up": { Icon: ChevronDown, turned: true },
  "chevron.down": { Icon: ChevronDown, turned: false },
  ellipsis: { Icon: MoreHorizontal, turned: false },
} satisfies Record<string, { Icon: ComponentType<IconProps>; turned: boolean }>;

/** What a panel screen offers in its bar: a button, or a menu of things to do. */
export type PanelTool =
  | { kind: "button"; icon: keyof typeof faces; label: string; disabled?: boolean; onPress: () => void }
  | { kind: "menu"; icon: keyof typeof faces; label: string; items: { label: string; icon: Symbol; onPress: () => void }[] };

interface PanelHeaderProps {
  title: string;
  line: string | null;
  fromCloud?: boolean;
  tools?: PanelTool[];
}

/** The pane's bar buttons: the Home bar's circles, as both are the app's own bars. */
const circle = "size-10 items-center justify-center rounded-full bg-surface active:bg-surface-3";
/** The bar's height under the status bar: iOS's own, so its circles and title stand level with the thread header's beside it. */
const BAR_HEIGHT = 44;

function Face({ icon }: { icon: keyof typeof faces }) {
  const { Icon, turned } = faces[icon];
  return (
    <View style={turned ? { transform: [{ rotate: "180deg" }] } : undefined}>
      <Icon size={20} className="text-ink-3" />
    </View>
  );
}

function PaneTool({ tool }: { tool: PanelTool }) {
  const mode = useMode();
  if (tool.kind === "button")
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={tool.label} disabled={tool.disabled} onPress={tool.onPress} hitSlop={2} className={cn(circle, tool.disabled && "opacity-40")}>
        <Face icon={tool.icon} />
      </Pressable>
    );
  return (
    <Host matchContents colorScheme={mode}>
      <Menu
        modifiers={[accessibilityLabel(tool.label)]}
        label={
          <RNHostView matchContents>
            <View className={circle}>
              <Face icon={tool.icon} />
            </View>
          </RNHostView>
        }
      >
        {tool.items.map((item) => (
          <Button key={item.label} label={item.label} systemImage={item.icon} onPress={item.onPress} />
        ))}
      </Menu>
    </Host>
  );
}

/** The pane's own bar: back, or close from the pane's first screen, the title in the middle, the screen's tools after. */
function PaneBar({ screen, title, line, fromCloud, tools = [] }: PanelHeaderProps & { screen: PaneScreen }) {
  const insets = useSafeAreaInsets();
  const Leave = screen.first ? X : ChevronLeft;
  return (
    <View className="flex-row items-center gap-2 bg-bg px-3" style={{ paddingTop: insets.top, height: insets.top + BAR_HEIGHT }}>
      <View className="flex-1 flex-row">
        <Pressable accessibilityRole="button" accessibilityLabel={screen.first ? "Close" : "Back"} onPress={pane.back} hitSlop={2} className={circle}>
          <Leave size={20} className="text-ink-3" />
        </Pressable>
      </View>
      <PanelTitle title={title} line={line} fromCloud={fromCloud} />
      <View className="flex-1 flex-row justify-end gap-2">
        {tools.map((tool) => (
          <PaneTool key={tool.label} tool={tool} />
        ))}
      </View>
    </View>
  );
}

/** A tool as the stack's header takes it: the toolbar reads its own elements, so this is no component of its own. */
function stackTool(tool: PanelTool) {
  if (tool.kind === "button") return <Stack.Toolbar.Button key={tool.label} icon={tool.icon} accessibilityLabel={tool.label} disabled={tool.disabled} onPress={tool.onPress} />;
  return (
    <Stack.Toolbar.Menu key={tool.label} icon={tool.icon} accessibilityLabel={tool.label}>
      {tool.items.map((item) => (
        <Stack.Toolbar.MenuAction key={item.label} icon={item.icon} onPress={item.onPress}>
          {item.label}
        </Stack.Toolbar.MenuAction>
      ))}
    </Stack.Toolbar.Menu>
  );
}

/**
 * A panel screen's title and tools, wherever it stands: the stack's header over the thread, or the pane's own bar
 * beside it. It changes only with its words and tools, so a screen that draws often does not redraw its bar.
 */
export const PanelHeader = memo(function PanelHeader({ title, line, fromCloud = false, tools }: PanelHeaderProps) {
  const screen = useContext(PaneScreenContext);
  const options = useMemo(() => ({ headerTitle: () => <PanelTitle title={title} line={line} fromCloud={fromCloud} /> }), [title, line, fromCloud]);
  if (screen) return <PaneBar screen={screen} title={title} line={line} fromCloud={fromCloud} tools={tools} />;
  return (
    <>
      <Stack.Screen options={options} />
      {tools?.length ? <Stack.Toolbar placement="right">{tools.map(stackTool)}</Stack.Toolbar> : null}
    </>
  );
});
