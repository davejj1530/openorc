import { Text as NativeText, type TextProps } from "react-native";
import { cn } from "./cn";

/** Interface text: Immaculate Gothic at the desktop's 13/20 in ink unless the classes say otherwise. */
export function Text({ className, ...props }: TextProps) {
  return <NativeText className={cn("font-sans text-base text-ink", className)} {...props} />;
}
