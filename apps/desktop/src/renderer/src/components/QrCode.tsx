import { useMemo } from "react";
import { encode } from "uqr";

/** The dark modules as one path, a subpath per run of dark modules in a row, so a dense code stays a single node. */
export function qrPath(value: string): { size: number; d: string } {
  const { size, data } = encode(value, { border: 0 });
  const runs: string[] = [];
  data.forEach((row, y) => {
    for (let x = 0; x < size; x++) {
      if (!row[x] || row[x - 1]) continue;
      let width = 1;
      while (row[x + width]) width++;
      runs.push(`M${x} ${y}h${width}v1h-${width}z`);
    }
  });
  return { size, d: runs.join("") };
}

/** A QR code in the current text color, edge to edge. The quiet zone around it is the caller's padding. */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { size, d } = useMemo(() => qrPath(value), [value]);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges">
      <path d={d} fill="currentColor" />
    </svg>
  );
}
