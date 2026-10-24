import { View } from "react-native";
import type { LinkTone } from "../connection/link-words";
import { cn } from "../ui/cn";

const tones: Record<LinkTone, string> = { ok: "bg-ok", busy: "bg-ink-4", attention: "bg-attention", off: "bg-line-strong" };

/** The connection's state as a small dot; whatever shows it carries the words. */
export function LinkDot({ tone, className }: { tone: LinkTone; className?: string }) {
  return <View className={cn("size-2 rounded-full", tones[tone], className)} />;
}
