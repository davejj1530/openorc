import { useId } from "react";
import type { Orcling, OrclingLook } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { useLayout } from "../lib/layout";
import { orclingById, useOrclings } from "../lib/orclings";
import { Tooltip } from "./ui";
import { ORCLING_SHAPES, orclingAccessory, orclingEyes, orclingGlasses } from "./orcling-art";

/** Light from the top left and shade at the bottom right, over any body color. */
function Texture({ id, body, look }: { id: string; body: string; look: OrclingLook }) {
  if (look.texture === 0) return null;
  return (
    <>
      <defs>
        <radialGradient id={`${id}-light`} cx="0.32" cy="0.28" r="0.8">
          <stop offset="0" stopColor="#fff" stopOpacity={look.texture === 2 ? 0.45 : 0.3} />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.18" />
        </radialGradient>
      </defs>
      <path d={body} fill={`url(#${id}-light)`} />
      {look.texture === 2 ? <ellipse cx="35" cy="28" rx="9" ry="5" fill="#fff" opacity="0.7" transform="rotate(-24 35 28)" /> : null}
      {look.texture === 3 ? <path d={body} fill="none" stroke={look.bodyColor} strokeWidth="7" strokeDasharray="0.1 5.5" strokeLinecap="round" /> : null}
    </>
  );
}

function Glasses({ style, color }: { style: number; color: string }) {
  const glasses = orclingGlasses(style);
  if (!glasses) return null;
  return (
    <>
      {glasses.lenses ? <path d={glasses.lenses} fill="#1b1c20" /> : null}
      <path d={glasses.frames} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" />
    </>
  );
}

function Accessory({ style }: { style: number }) {
  const accessory = orclingAccessory(style);
  if (!accessory) return null;
  return (
    <>
      <path d={accessory.path} fill={accessory.fill} />
      {accessory.detail ? <path d={accessory.detail.path} fill={accessory.detail.fill} /> : null}
    </>
  );
}

/** An Orcling's flat drawing: body, texture, eyes, glasses and accessory, from its look. */
export function OrclingStill({ look, size, className }: { look: OrclingLook; size: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  const body = ORCLING_SHAPES[look.shape]?.path ?? ORCLING_SHAPES[0]!.path;
  const eyes = orclingEyes(look.eyes);
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true" className={cn("orcling-avatar", className)}>
      <path d={body} fill={look.bodyColor} />
      <Texture id={id} body={body} look={look} />
      <path d={eyes.path} fill={look.eyeColor} />
      {eyes.glints ? <path d={eyes.glints} fill="#fff" /> : null}
      <Glasses style={look.glasses} color={look.eyeColor} />
      <Accessory style={look.accessory} />
    </svg>
  );
}

/** A body shape alone, for choosing one. */
export function OrclingSilhouette({ shape, color, size }: { shape: number; color: string; size: number }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true" className="orcling-avatar">
      <path d={ORCLING_SHAPES[shape]?.path ?? ORCLING_SHAPES[0]!.path} fill={color} />
    </svg>
  );
}

/** An Orcling in a list or byline, drawn from its look. */
export function OrclingAvatar({ orcling, size = 24, className }: { orcling: Pick<Orcling, "look">; size?: number; className?: string }) {
  return <OrclingStill look={orcling.look} size={size} className={className} />;
}

/** The Orcling working in a conversation, beside its title; opens its profile. */
export function ThreadOrcling({ threadId, orclingId }: { threadId: string; orclingId: string | null | undefined }) {
  const orcling = orclingById(useOrclings(), orclingId);
  if (!orcling) return null;
  return (
    <Tooltip label={orcling.name}>
      <button type="button" aria-label={`${orcling.name}'s profile`} className="inline-flex shrink-0 mr-1.5" onClick={() => useLayout.getState().openThreadPanel(threadId, "orcling")}>
        <OrclingAvatar orcling={orcling} size={20} />
      </button>
    </Tooltip>
  );
}
