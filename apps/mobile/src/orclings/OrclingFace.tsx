import { ORCLING_INKS, ORCLING_SHAPES, orclingAccessory, orclingEyes, orclingGlasses } from "@openorc/client";
import type { OrclingLook } from "@openorc/protocol";
import { memo, useId } from "react";
import Svg, { Defs, Ellipse, Path, RadialGradient, Stop } from "react-native-svg";

/** Light from the top left and shade at the bottom right, over any body color. */
export function Texture({ id, body, look }: { id: string; body: string; look: OrclingLook }) {
  if (look.texture === 0) return null;
  return (
    <>
      <Defs>
        <RadialGradient id={id} cx="0.32" cy="0.28" r="0.8">
          <Stop offset="0" stopColor={ORCLING_INKS.light} stopOpacity={look.texture === 2 ? 0.45 : 0.3} />
          <Stop offset="0.55" stopColor={ORCLING_INKS.light} stopOpacity="0" />
          <Stop offset="1" stopColor={ORCLING_INKS.shade} stopOpacity="0.18" />
        </RadialGradient>
      </Defs>
      <Path d={body} fill={`url(#${id})`} />
      {look.texture === 2 ? <Ellipse cx="35" cy="28" rx="9" ry="5" fill={ORCLING_INKS.light} opacity={0.7} transform="rotate(-24 35 28)" /> : null}
      {look.texture === 3 ? <Path d={body} fill="none" stroke={look.bodyColor} strokeWidth={7} strokeDasharray="0.1 5.5" strokeLinecap="round" /> : null}
    </>
  );
}

/**
 * An Orcling's flat drawing on a 100-unit square: body, texture, eyes, glasses and accessory, from its look. The
 * shapes are the desktop's, from `@openorc/client`, so a face reads the same on both.
 */
export const OrclingFace = memo(function OrclingFace({ look, size }: { look: OrclingLook; size: number }) {
  const id = `texture-${useId().replace(/[^\w-]/g, "")}`;
  const body = ORCLING_SHAPES[look.shape]?.path ?? ORCLING_SHAPES[0]!.path;
  const eyes = orclingEyes(look.eyes);
  const glasses = orclingGlasses(look.glasses);
  const accessory = orclingAccessory(look.accessory);
  return (
    <Svg viewBox="0 0 100 100" width={size} height={size} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Path d={body} fill={look.bodyColor} />
      <Texture id={id} body={body} look={look} />
      <Path d={eyes.path} fill={look.eyeColor} />
      {eyes.glints ? <Path d={eyes.glints} fill={ORCLING_INKS.light} /> : null}
      {glasses?.lenses ? <Path d={glasses.lenses} fill={ORCLING_INKS.lens} /> : null}
      {glasses ? <Path d={glasses.frames} fill="none" stroke={look.eyeColor} strokeWidth={3} strokeLinecap="round" /> : null}
      {accessory ? <Path d={accessory.path} fill={accessory.fill} /> : null}
      {accessory?.detail ? <Path d={accessory.detail.path} fill={accessory.detail.fill} /> : null}
    </Svg>
  );
});
