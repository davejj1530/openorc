import type { HarnessId } from "@openorc/protocol";
import claudeLogo from "../assets/providers/claude.svg";
import openaiLogo from "../assets/providers/openai.svg";
import opencodeLogo from "../assets/providers/opencode.svg";
import { cn } from "../lib/cn";

/** Each harness ships its own mark; a new harness must bring one. */
export const harnessLogos = { claude: claudeLogo, codex: openaiLogo, opencode: opencodeLogo } satisfies Record<HarnessId, string>;

/** The harness mark at icon size. Dark marks invert in dark themes through the `data-provider` attribute. */
export function HarnessLogo({ id, size = 16, className }: { id: HarnessId; size?: number; className?: string }) {
  return <img className={cn("harness-logo", className)} data-provider={id} src={harnessLogos[id]} alt="" width={size} height={size} aria-hidden="true" />;
}
