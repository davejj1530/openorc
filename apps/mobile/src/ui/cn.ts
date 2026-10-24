import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import { text } from "../generated/tokens";

// The desktop's type steps (md, prose, title-sm...) are font sizes; without them tailwind-merge reads text-title-sm
// as a color and drops it next to text-ink.
const merge = extendTailwindMerge({ extend: { theme: { text: Object.keys(text) } } });

export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
