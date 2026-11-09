import { useEffect, useState, type ReactNode } from "react";
import Animated from "react-native-reanimated";
import { motion } from "../generated/tokens";
import { ease } from "../ui/motion";
import { useReducedMotion } from "../ui/reduced-motion";
import type { HomeTab } from "./BottomBar";

/** The tab left fades out quickly; the tab chosen rises in once the last is nearly gone, so two lists never read over each other. */
const LEAVE = motion.duration.quick;
const ARRIVE_AFTER = LEAVE / 2;

function pace(still: boolean, visible: boolean) {
  if (still) return { transitionDuration: 0, transitionDelay: 0 };
  return visible ? { transitionDuration: motion.duration.arrive, transitionDelay: ARRIVE_AFTER } : { transitionDuration: LEAVE, transitionDelay: 0 };
}

/** One tab's layer. A layer built after Home first showed starts out of view, so even a first visit rises in. */
function Layer({ shown, built, children }: { shown: boolean; built: boolean; children: ReactNode }) {
  const still = useReducedMotion();
  const [placed, setPlaced] = useState(built);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const visible = shown && placed;
  return (
    <Animated.View
      pointerEvents={shown ? "auto" : "none"}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
      className="absolute inset-0"
      style={{
        opacity: visible ? 1 : 0,
        transform: [{ translateY: visible ? 0 : motion.arrive.rise }],
        transitionProperty: ["opacity", "transform"],
        ...pace(still, visible),
        transitionTimingFunction: ease.out,
      }}
    >
      {children}
    </Animated.View>
  );
}

/**
 * Home's tabs as layers that fade through: the one left fades out, then the chosen one rises in. A tab stays mounted
 * once it has shown, so coming back to it keeps where its list was scrolled; one not yet visited is not built. A hidden
 * layer takes no touches, and VoiceOver skips it.
 */
export function TabLayers({ tab, render }: { tab: HomeTab; render: (tab: HomeTab) => ReactNode }) {
  const [seen, setSeen] = useState<readonly HomeTab[]>([tab]);
  if (!seen.includes(tab)) setSeen([...seen, tab]);
  return (
    <>
      {seen.map((each, index) => (
        <Layer key={each} shown={each === tab} built={index === 0}>
          {render(each)}
        </Layer>
      ))}
    </>
  );
}
