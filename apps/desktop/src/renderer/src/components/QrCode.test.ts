import { encode } from "uqr";
import { expect, it } from "vitest";
import { qrPath } from "./QrCode";

it("draws exactly the dark modules of the code", () => {
  const value = `openorc://pair#v1.${"eyJuYW1lIjoiU3R1ZGlvIn0".repeat(20)}`;
  const { size, d } = qrPath(value);
  const drawn = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  for (const [, x, y, width] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) for (let i = 0; i < Number(width); i++) drawn[Number(y)]![Number(x) + i] = true;
  expect(drawn).toEqual(encode(value, { border: 0 }).data);
});
