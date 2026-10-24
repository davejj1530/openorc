import { StatusBar } from "expo-status-bar";

/**
 * For a sheet that rises the full height: iOS sets the screen beneath back on black, so the clock and battery turn
 * light over it in either theme, as over the system's own sheets. Leaving the sheet hands the bar back to the app's.
 */
export function SheetStatusBar() {
  return <StatusBar style="light" />;
}
