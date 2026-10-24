import "../global.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { restoreAppearance } from "../appearance";
import { link, queryClient } from "../client";
import { fonts } from "../generated/tokens";
import { leaveOnMacChange } from "../navigation";
import { useColors, useMode } from "../ui/mode";

// A pairing link opens the Pair screen over Home, so leaving it lands on Home.
export const unstable_settings = { anchor: "index" };

restoreAppearance();

// A sheet opens once however quickly its button is tapped twice; a thread opens once per thread.
const sheet = { presentation: "formSheet", sheetGrabberVisible: true } as const;
const onePerThread = (_name: string, params: Record<string, unknown>) => String(params.id);

export default function RootLayout() {
  const colors = useColors();
  const mode = useMode();
  useEffect(() => leaveOnMacChange(link, () => router.dismissTo("/")), []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="auto" />
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
            {/* The back button's long-press menu and VoiceOver name Home by this title. */}
            <Stack.Screen name="index" options={{ title: "Threads" }} />
            <Stack.Screen
              name="thread/[id]"
              dangerouslySingular={onePerThread}
              options={{
                headerShown: true,
                title: "",
                headerBackButtonDisplayMode: "minimal",
                headerShadowVisible: false,
                headerTintColor: colors.ink,
                headerStyle: { backgroundColor: colors.bg },
                headerTitleStyle: { fontFamily: fonts.text },
                // The header's More menu takes its look from this; left to the navigation theme, which the app does
                // not set, it would stay light in dark mode.
                headerUserInterfaceStyle: mode,
              }}
            />
            <Stack.Screen name="pair" dangerouslySingular options={{ presentation: "modal" }} />
            <Stack.Screen name="new" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: [1] }} />
            <Stack.Screen name="macs" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: [0.5, 1] }} />
            <Stack.Screen name="appearance" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: "fitToContents" }} />
            <Stack.Screen name="filter" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: "fitToContents" }} />
            <Stack.Screen name="tool" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
            <Stack.Screen name="model" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
            <Stack.Screen name="mode" dangerouslySingular options={{ ...sheet, sheetAllowedDetents: "fitToContents" }} />
          </Stack>
        </QueryClientProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
