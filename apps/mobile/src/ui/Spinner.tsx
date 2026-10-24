import Animated, { useReducedMotion } from "react-native-reanimated";
import { Loader2 } from "../generated/icons";
import { spin } from "./motion";

/** The desktop's working mark: Loader2 turning. Still under reduced motion. */
export function Spinner({ size = 16, className = "text-ink-4" }: { size?: number; className?: string }) {
  const still = useReducedMotion();
  return (
    <Animated.View style={still ? undefined : spin}>
      <Loader2 size={size} className={className} />
    </Animated.View>
  );
}
