import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * The room a sheet leaves under its last control: `gap`, plus the home indicator's inset while the keyboard is down.
 * Over the keyboard there is no home indicator, and its inset would leave a band between the control and the keys.
 */
export function useSheetBottom(gap: number): number {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardState((state) => state.isVisible);
  return gap + (keyboard ? 0 : insets.bottom);
}
