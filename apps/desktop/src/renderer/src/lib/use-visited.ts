import { useState } from "react";

/**
 * Whether something has been open at least once, so its content mounts on first open and then stays. Set while
 * rendering rather than in an effect, so the content is there in the frame it opens and a collapse unfolds to its
 * full height.
 */
export function useVisited(open: boolean): boolean {
  const [visited, setVisited] = useState(open);
  if (open && !visited) setVisited(true);
  return visited;
}
