import { useFits } from "../lib/use-fits";

/** The foot's line under the name, in two lengths: the longer words where the foot has room for them, the shorter where not. */
export function AccountLine({ words, tip }: { words: { long: string; short: string }; tip?: string | undefined }) {
  const { box, measure, fits } = useFits<HTMLSpanElement, HTMLSpanElement>(words.long);
  return (
    <span ref={box} className="sidebar-account-plan" data-tip={tip}>
      {/* Measured from an attribute, so the line's own text holds the words once. */}
      <span ref={measure} className="sidebar-account-plan-measure" data-words={words.long} aria-hidden="true" />
      {fits ? words.long : words.short}
    </span>
  );
}
