import { useState, type ReactNode } from "react";
import { ScrollView, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSheetBottom } from "./sheet-bottom";

/** Room kept under the status bar: iOS 26 starts a sheet at its full height there, earlier versions 10 pt lower. */
const SHEET_TOP_GAP = 10;

/**
 * The height of a sheet as tall as what it holds: none of its own while that fits, so the sheet takes the content's;
 * the room under the status bar when it does not, so the content scrolls inside it.
 */
export function fitSheetHeight(content: number, window: number, top: number): number | undefined {
  const room = window - top - SHEET_TOP_GAP;
  return content > room ? room : undefined;
}

/**
 * The body of a sheet as tall as what it holds (`sheetAllowedDetents: "fitToContents"`), scrolling inside the screen
 * when what it holds is taller, its last row clear of the home indicator.
 */
export function FitSheet({ className, onAccessibilityEscape, children }: { className: string; onAccessibilityEscape: () => void; children: ReactNode }) {
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const bottom = useSheetBottom(16);
  const [content, setContent] = useState(0);
  const height = fitSheetHeight(content, window.height, insets.top);
  return (
    <ScrollView
      className="bg-bg"
      style={height === undefined ? undefined : { height }}
      scrollEnabled={height !== undefined}
      onContentSizeChange={(_, contentHeight) => setContent(contentHeight)}
      contentContainerClassName={className}
      contentContainerStyle={{ paddingBottom: bottom }}
      onAccessibilityEscape={onAccessibilityEscape}
    >
      {children}
    </ScrollView>
  );
}
