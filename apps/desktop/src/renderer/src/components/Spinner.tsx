import { cn } from "../lib/cn";
import { Loader2 } from "./icons";

/**
 * Something in progress. The span turns rather than the icon: the browser turns an element on the compositor, while
 * an SVG animating its own transform is restyled and repainted on the main thread for every frame it shows.
 */
export function Spinner({ size, className }: { size: number; className?: string }) {
  return (
    <span className={cn("spinner", className)}>
      <Loader2 size={size} />
    </span>
  );
}
