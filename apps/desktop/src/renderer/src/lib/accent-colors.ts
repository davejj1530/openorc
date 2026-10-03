import { toHex } from "./color";

const channels = (hex: string) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));

/** Resolve authored CSS colors once, while keeping hex-only calculations usable outside the browser. */
export function accentHex(color: string | undefined): string {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : (toHex(color) ?? "#808080");
}

export function mixColor(color: string, background: string, amount: number): string {
  const back = channels(background);
  return `#${channels(color)
    .map((channel, index) =>
      Math.round(channel * amount + back[index]! * (1 - amount))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function luminance(hex: string): number {
  const linear = channels(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

export function contrastRatio(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function onColor(background: string): string {
  return contrastRatio("#ffffff", background) >= contrastRatio("#000000", background) ? "#ffffff" : "#000000";
}

/** Preserve the selected hue, moving toward readable ink only as far as needed. */
export function readableAccent(color: string, background: string, minimum = 4.5): string {
  const end = onColor(background);
  for (let step = 0; step <= 100; step++) {
    const candidate = mixColor(end, color, step / 100);
    if (contrastRatio(candidate, background) >= minimum) return candidate;
  }
  return end;
}

export function accentPair(color: string, background: string): { ink: string; soft: string } {
  const soft = mixColor(color, background, 0.12);
  // The tint is the more demanding surface: links also appear on the plain canvas.
  return { ink: readableAccent(color, soft), soft };
}
