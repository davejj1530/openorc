import type { ReactNode } from "react";

/** A swipeable row in tests: its row only; the swipe's rules are tested apart. */
export enum SwipeDirection {
  LEFT = "left",
  RIGHT = "right",
}
export default function ReanimatedSwipeable({ children }: { children: ReactNode }) {
  return children;
}
