import { formatUsageTime, graceDeadlineWords } from "@openorc/client";
import { useFits } from "../lib/use-fits";

/** When Pro ends, in the plan line's place: the longer words where the foot has room for them, the shorter where not. */
export function AccountGraceLine({ until, now }: { until: number; now: number }) {
  const words = graceDeadlineWords(until, now);
  const { box, measure, fits } = useFits<HTMLSpanElement, HTMLSpanElement>(words.long);
  return (
    <span ref={box} className="sidebar-account-grace" data-tip={formatUsageTime(until)}>
      {/* Measured from an attribute, so the line's own text holds the words once. */}
      <span ref={measure} className="sidebar-grace-measure" data-words={words.long} aria-hidden="true" />
      {fits ? words.long : words.short}
    </span>
  );
}
