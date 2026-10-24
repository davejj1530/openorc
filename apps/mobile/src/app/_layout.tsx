import "../global.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { queryClient } from "../client";
import { fonts } from "../generated/tokens";
import { useColors } from "../ui/mode";

// A pairing link opens the Pair screen over Home, so leaving it lands on Home.
export const unstable_settings = { anchor: "index" };

const sheet = { presentation: "formSheet", sheetGrabberVisible: true } as const;

export default function RootLayout() {
  const colors = useColors();
  return (
    <KeyboardProvider>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
          <Stack.Screen
            name="thread/[id]"
            options={{
              headerShown: true,
              title: "",
              headerBackButtonDisplayMode: "minimal",
              headerShadowVisible: false,
              headerTintColor: colors.ink,
              headerStyle: { backgroundColor: colors.bg },
              headerTitleStyle: { fontFamily: fonts.text },
            }}
          />
          <Stack.Screen name="pair" options={{ presentation: "modal" }} />
          <Stack.Screen name="new" options={{ ...sheet, sheetAllowedDetents: [1] }} />
          <Stack.Screen name="macs" options={{ ...sheet, sheetAllowedDetents: [0.5, 1] }} />
          <Stack.Screen name="tool" options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
          <Stack.Screen name="model" options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
          <Stack.Screen name="mode" options={{ ...sheet, sheetAllowedDetents: "fitToContents" }} />
        </Stack>
      </QueryClientProvider>
    </KeyboardProvider>
  );
}
