import "../global.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { queryClient } from "../client";
import { useColors } from "../ui/mode";

// A pairing link opens the Pair screen over Home, so leaving it lands on Home.
export const unstable_settings = { anchor: "index" };

export default function RootLayout() {
  const colors = useColors();
  return (
    <QueryClientProvider client={queryClient}>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="pair" options={{ presentation: "modal" }} />
        <Stack.Screen name="macs" options={{ presentation: "formSheet", sheetAllowedDetents: [0.5, 1], sheetGrabberVisible: true }} />
      </Stack>
    </QueryClientProvider>
  );
}
