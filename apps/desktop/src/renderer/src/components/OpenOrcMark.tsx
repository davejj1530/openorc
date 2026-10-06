import { useId } from "react";

const outline =
  "M17.91 2.5L26.74 7.6Q28.64 8.7 28.64 10.9L28.64 21.1Q28.64 23.3 26.74 24.4L17.91 29.5Q16 30.6 14.09 29.5L5.26 24.4Q3.36 23.3 3.36 21.1L3.36 10.9Q3.36 8.7 5.26 7.6L14.09 2.5Q16 1.4 17.91 2.5Z";
const faces = {
  top: "M16.78 4.27L23.66 8.25Q24.44 8.7 23.66 9.15L16.43 13.33Q16 13.58 15.57 13.33L8.34 9.15Q7.56 8.7 8.34 8.25L15.22 4.27Q16 3.82 16.78 4.27Z",
  right: "M18.53 16.96L25.76 12.79Q26.54 12.34 26.54 13.24L26.54 21.19Q26.54 22.09 25.76 22.54L18.88 26.51Q18.1 26.96 18.1 26.06L18.1 17.71Q18.1 17.21 18.53 16.96Z",
  left: "M6.24 12.79L13.47 16.96Q13.9 17.21 13.9 17.71L13.9 26.06Q13.9 26.96 13.12 26.51L6.24 22.54Q5.46 22.09 5.46 21.19L5.46 13.24Q5.46 12.34 6.24 12.79Z",
} as const;

/** OpenOrc's mark as one path: a cube seen from above, solid but for its lit top face. */
export const openOrcMarkPath = `${outline}${faces.top}`;

/**
 * OpenOrc's mark; the surrounding UI supplies its color. While an agent works the light moves around the cube, one
 * face at a time. The faces are cut through a mask, so the mark still shows whatever it sits on.
 */
export function OpenOrcMark({ size = 30, working = false, className }: { size?: number; working?: boolean; className?: string }) {
  const mask = `openorc-mark-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={className}>
      {working ? (
        <>
          <mask id={mask}>
            <path fill="white" d={outline} />
            {(["top", "right", "left"] as const).map((face) => (
              <path key={face} className="openorc-mark-face" data-face={face} fill="black" d={faces[face]} />
            ))}
          </mask>
          <rect width="32" height="32" fill="currentColor" mask={`url(#${mask})`} />
        </>
      ) : (
        <path fill="currentColor" fillRule="evenodd" d={openOrcMarkPath} />
      )}
    </svg>
  );
}
