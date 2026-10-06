let next = 0;

/** A document-unique id for an SVG mask or gradient that a component repeats on one page. */
export function svgId(prefix: string): string {
  next += 1;
  return `${prefix}-${next}`;
}
