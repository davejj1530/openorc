import { Text as NativeText, type TextProps } from "react-native";
import { cn } from "./cn";

/** How far interface text grows with the reader's text size, so rows, pills and bars keep their shape. */
const CHROME_SCALE = 1.4;

/**
 * Interface text: Immaculate Gothic at the desktop's 13/20 in ink unless the classes say otherwise. It grows with the
 * reader's text size up to a point; `prose` (what people and agents wrote, code and output) grows all the way.
 */
export function Text({ className, prose = false, ...props }: TextProps & { prose?: boolean }) {
  return <NativeText maxFontSizeMultiplier={prose ? 0 : CHROME_SCALE} className={cn("font-sans text-base text-ink", className)} {...props} />;
}
