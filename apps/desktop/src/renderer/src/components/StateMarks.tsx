import { useId, type ReactNode } from "react";
import { cn } from "../lib/cn";

type MarkProps = { size?: number; className?: string };

/**
 * The marks of a state: each a solid shape with one cut, in the cube's family, so a state is told by its outline and
 * never by its colour alone. Drawn in currentColor on a 16 grid; the caller gives the hue.
 */

function SolidMark({ name, size = 14, className, shape, cut, cutWidth = 1.5 }: MarkProps & { name: string; shape: ReactNode; cut?: string; cutWidth?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" data-mark={name} className={cn("shrink-0", className)}>
      <mask id={id}>
        <rect width="16" height="16" fill="#000" />
        <g fill="#fff">{shape}</g>
        {cut ? <path d={cut} fill="none" stroke="#000" strokeWidth={cutWidth} strokeLinecap="round" strokeLinejoin="round" /> : null}
      </mask>
      <rect width="16" height="16" fill="currentColor" mask={`url(#${id})`} />
    </svg>
  );
}

/** It waits on the person's answer: a disc with a question cut out. */
export function AskMark(props: MarkProps) {
  return <SolidMark name="ask" {...props} shape={<circle cx="8" cy="8" r="7" />} cut="M6.1 6.3a1.95 1.95 0 1 1 3.1 1.6c-.7.5-1.2.9-1.2 1.7 M8 11.7v.05" />;
}

/** It waits on the person and is not a question, such as a task ready for review: the disc with no cut. */
export function WaitMark(props: MarkProps) {
  return <SolidMark name="wait" {...props} shape={<circle cx="8" cy="8" r="6.5" />} />;
}

/** It failed: a triangle with a stroke cut out. */
export function FailedMark(props: MarkProps) {
  return <SolidMark name="failed" {...props} shape={<path d="M8 1.5Q9 1.5 9.55 2.5L14.75 11.6Q15.6 13.9 13.3 14.1H2.7Q.4 13.9 1.25 11.6L6.45 2.5Q7 1.5 8 1.5Z" />} cut="M8 6v3.2 M8 11.5v.05" />;
}

/** Its turn ended and a command it started still runs: a rounded square with a prompt cut out. */
export function BackgroundMark(props: MarkProps) {
  return <SolidMark name="background" {...props} shape={<rect x="1.5" y="2.5" width="13" height="11" rx="3" />} cut="M4.9 6.4l2 1.6-2 1.6 M8.6 9.9h2.4" cutWidth={1.35} />;
}

/** A note in the thread tags the person and they have not read it: the @ in the slot's own ink. */
export function MentionMark() {
  return (
    <span data-mark="mention" className="mention-mark">
      @
    </span>
  );
}

/** A result the person has not read: a 7px dot. */
export function UnreadMark() {
  return <span data-mark="unread" className="size-1.75 shrink-0 rounded-full bg-ink" />;
}
