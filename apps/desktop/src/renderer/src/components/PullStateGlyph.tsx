import type { PullRequestStateFilter } from "@openorc/protocol";
import { cn } from "../lib/cn";

/**
 * A pull request state's mark, as the rows and the state tabs draw it, in the tones the list has always used: open is
 * a ring around a dot in the ok tone, a draft a faint dashed ring, merged a full-ink disc with a check, closed a ring
 * crossed in the bad tone, and all of them two rings.
 */
export function PullStateGlyph({ state, size = 14, className }: { state: PullRequestStateFilter; size?: number; className?: string }) {
  const common = { width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": true, className: cn("pull-glyph shrink-0", `pull-glyph-${state}`, className) } as const;
  if (state === "open")
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="8" cy="8" r="2.25" fill="currentColor" />
      </svg>
    );
  if (state === "draft")
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.4 2.2" />
      </svg>
    );
  if (state === "merged")
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path d="M5.2 8.2l1.9 1.9 3.8-4" fill="none" stroke="var(--surface)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (state === "closed")
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="6" cy="8" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10" cy="8" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
