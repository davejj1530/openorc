import { useEffect, useState } from "react";
import type { TeamMemberAvatarChoice } from "@openorc/protocol";
import avatar01 from "../assets/team-avatars/avatar-01-facet.png";
import avatar02 from "../assets/team-avatars/avatar-02-ripple.png";
import avatar03 from "../assets/team-avatars/avatar-03-helix.png";
import avatar04 from "../assets/team-avatars/avatar-04-portal.png";
import avatar05 from "../assets/team-avatars/avatar-05-strata.png";
import avatar06 from "../assets/team-avatars/avatar-06-knot.png";
import avatar07 from "../assets/team-avatars/avatar-07-split.png";
import avatar08 from "../assets/team-avatars/avatar-08-bloom.png";
import avatar09 from "../assets/team-avatars/avatar-09-orbit.png";
import avatar10 from "../assets/team-avatars/avatar-10-fold.png";
import avatar11 from "../assets/team-avatars/avatar-11-lens.png";
import avatar12 from "../assets/team-avatars/avatar-12-axis.png";
import { cn } from "../lib/cn";

export const TEAM_AVATARS = [
  { name: "Hollow", src: avatar01 },
  { name: "Ripple", src: avatar02 },
  { name: "Helix", src: avatar03 },
  { name: "Portal", src: avatar04 },
  { name: "Strata", src: avatar05 },
  { name: "Knot", src: avatar06 },
  { name: "Split", src: avatar07 },
  { name: "Bloom", src: avatar08 },
  { name: "Orbit", src: avatar09 },
  { name: "Fold", src: avatar10 },
  { name: "Lens", src: avatar11 },
  { name: "Axis", src: avatar12 },
] as const;

const sizes = { sm: "size-6", md: "size-8", lg: "size-10" } as const;

function defaultAvatar(index: number) {
  const normalized = Number.isSafeInteger(index) ? ((index % TEAM_AVATARS.length) + TEAM_AVATARS.length) % TEAM_AVATARS.length : 0;
  return TEAM_AVATARS[normalized]!;
}

function customAvatarSource(path: string): string {
  return `openorc-asset://local-image/?path=${encodeURIComponent(path)}`;
}

/**
 * A member's durable identity. Broken custom files fall back to the bundled
 * pool instead of leaving a broken-image glyph in the conversation.
 */
export function MemberAvatar({
  avatar,
  fallbackIndex = 0,
  size = "md",
  alt = "",
  className,
}: {
  avatar?: TeamMemberAvatarChoice | null;
  fallbackIndex?: number;
  size?: keyof typeof sizes;
  alt?: string;
  className?: string;
}) {
  const customPath = avatar?.kind === "custom" ? avatar.path : null;
  const [customFailed, setCustomFailed] = useState(false);
  useEffect(() => setCustomFailed(false), [customPath]);

  const bundled = defaultAvatar(avatar?.kind === "default" ? avatar.index : fallbackIndex);
  const src = customPath && !customFailed ? customAvatarSource(customPath) : bundled.src;
  return <img src={src} alt={alt} className={cn("shrink-0 object-contain", sizes[size], className)} onError={customPath && !customFailed ? () => setCustomFailed(true) : undefined} />;
}
