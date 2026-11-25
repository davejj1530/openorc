import "../global.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, type ComponentProps } from "react";
import { useWindowDimensions, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { restoreAppearance } from "../appearance";
import { link, queryClient, useLinkState } from "../client";
import { fonts } from "../generated/tokens";
import { HomeScreen } from "../home/HomeScreen";
import { LIST_WIDTH, panelWidth, SplitProvider, splits } from "../layout";
import { useMacLook } from "../look/use-mac-look";
import { leaveOnMacChange } from "../navigation";
import { pane, usePaneRoutes } from "../panel/pane";
import { PanelPane } from "../panel/PanelPane";
import { useNoticeTaps } from "../notifications/use-notice-taps";
import { useColors, useMode } from "../ui/mode";
import { Pane } from "../ui/pane";

// A pairing link opens the Pair screen over Home, so leaving it lands on Home.
export const unstable_settings = { anchor: "index" };

restoreAppearance();

// A sheet opens once however quickly its button is tapped twice; a thread opens once per thread.
const sheet = { presentation: "formSheet", sheetGrabberVisible: true } as const;
const onePerThread = (_name: string, params: Record<string, unknown>) => String(params.id);
const onePerPanel = (_name: string, params: Record<string, unknown>) => String(params.threadId);
/** Beside the list a screen stands where another stood: it comes with no slide, and has nothing to go back to. */
const beside = { animation: "none", headerBackVisible: false, gestureEnabled: false } as const;

/** Holds the shown Mac's look on the phone; draws nothing. */
function MacLook() {
  useMacLook();
  return null;
}

export default function RootLayout() {
  const colors = useColors();
  const mode = useMode();
  const window = useWindowDimensions().width;
  // The list stands beside what it opens once a Mac is shown; pairing has no list to show.
  const split = useLinkState().kind !== "unpaired" && splits(window);
  // A thread's side panel stands beside it where that leaves the thread room; elsewhere its screens go over the thread.
  const panel = split ? panelWidth(window) : 0;
  useEffect(() => pane.setRoom(panel > 0), [panel]);
  const panelRoutes = usePaneRoutes();
  const panelShown = panelRoutes.length > 0 ? panel : 0;
  useEffect(() => leaveOnMacChange(link, () => router.dismissTo("/")), []);
  useNoticeTaps();
  const pushed = {
    headerShown: true,
    title: "",
    headerBackButtonDisplayMode: "minimal",
    headerShadowVisible: false,
    headerTintColor: colors.ink,
    headerStyle: { backgroundColor: colors.bg },
    headerTitleStyle: { fontFamily: fonts.text },
    // The header's menus take their look from this; left to the navigation theme, which the app does not set, they
    // would stay light in dark mode.
    headerUserInterfaceStyle: mode,
  } as const;
  // What the list opens sits first over Home's place in the stack.
  const opened: NonNullable<ComponentProps<typeof Stack.Screen>["options"]> = ({ route, navigation }) =>
    split && navigation.getState().routes[1]?.key === route.key ? { ...pushed, ...beside } : pushed;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <QueryClientProvider client={queryClient}>
          <MacLook />
          <StatusBar style="auto" />
          <SplitProvider value={split}>
            <View className="flex-1 flex-row bg-bg">
              {split ? (
                <Pane width={LIST_WIDTH} style={{ width: LIST_WIDTH }} className="border-r border-line">
                  <HomeScreen />
                </Pane>
              ) : null}
              <Pane width={window - (split ? LIST_WIDTH : 0) - panelShown} className="flex-1">
                <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
                  {/* The back button's long-press menu and VoiceOver name Home by this title. */}
                  <Stack.Screen name="index" options={{ title: "Threads" }} />
                  <Stack.Screen name="thread/[id]" dangerouslySingular={onePerThread} options={opened} />
                  <Stack.Screen name="task/[id]" dangerouslySingular={onePerThread} options={opened} />
                  <Stack.Screen name="task-description" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: [1] }} />
                  <Stack.Screen name="subthreads" dangerouslySingular={onePerPanel} options={pushed} />
                  <Stack.Screen name="changes" dangerouslySingular={onePerPanel} options={pushed} />
                  <Stack.Screen name="cloud-changes" dangerouslySingular={onePerPanel} options={pushed} />
                  <Stack.Screen name="files" options={pushed} />
                  <Stack.Screen name="file" options={pushed} />
                  <Stack.Screen name="chat/[id]" dangerouslySingular={onePerThread} options={opened} />
                  <Stack.Screen name="preview" dangerouslySingular={onePerPanel} options={pushed} />
                  <Stack.Screen name="commit-changes" options={pushed} />
                  <Stack.Screen name="diff" options={pushed} />
                  <Stack.Screen name="cloud-diff" options={pushed} />
                  <Stack.Screen name="new" dangerouslySingular options={opened} />
                  <Stack.Screen name="new-subthread" dangerouslySingular={onePerPanel} options={pushed} />
                  <Stack.Screen name="new-task" dangerouslySingular options={opened} />
                  <Stack.Screen name="pair" dangerouslySingular options={{ presentation: "modal" }} />
                  <Stack.Screen name="settings" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: [1] }} />
                  <Stack.Screen name="filter" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: "fitToContents" }} />
                  <Stack.Screen name="space" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: "fitToContents" }} />
                  <Stack.Screen name="connection" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: "fitToContents" }} />
                  <Stack.Screen name="whats-new" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: "fitToContents" }} />
                  <Stack.Screen name="chat-pins" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
                  <Stack.Screen name="tool" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
                  <Stack.Screen name="model" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
                  <Stack.Screen name="mode" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: "fitToContents" }} />
                  <Stack.Screen name="project" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: [0.6, 1], contentStyle: { backgroundColor: colors.surface } }} />
                  <Stack.Screen name="commit" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: "fitToContents" }} />
                  <Stack.Screen name="pull-request" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: [1] }} />
                  <Stack.Screen name="cloud-commit" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: "fitToContents" }} />
                  <Stack.Screen name="cloud-pull-request" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: [1] }} />
                  <Stack.Screen name="branch" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
                  <Stack.Screen name="details" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
                  <Stack.Screen name="orcling" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: [1] }} />
                  <Stack.Screen name="orcling-look" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: [1] }} />
                  <Stack.Screen name="orcling-instructions" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: [1] }} />
                  <Stack.Screen name="orcling-new" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: [1] }} />
                </Stack>
              </Pane>
              {panelShown > 0 ? <PanelPane routes={panelRoutes} width={panelShown} /> : null}
            </View>
          </SplitProvider>
        </QueryClientProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
