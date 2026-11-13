import type { Orcling } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { OrclingStill } from "./OrclingAvatar";
import { OrclingPreview } from "./OrclingPreview";

type Member = Pick<Orcling, "id" | "look" | "name">;

/** Each face stands a third over the one before it, parted from it by a gap this many points wide. */
const OVERLAP = 1 / 3;
const RING = 1.5;

/** Several Orclings' faces overlapping, for a group chat: the first few, each cut away where the next stands in front. */
export function OrclingFaces({ members, size = 24, max = 3, className }: { members: readonly Member[]; size?: number; max?: number; className?: string }) {
  const shown = members.slice(0, max);
  return (
    <span className={cn("orcling-faces", className)} style={{ "--face": `${size}px` } as React.CSSProperties} aria-label={members.map((member) => member.name).join(", ")}>
      {shown.map((member, index) => {
        const front = shown[index + 1];
        return (
          <OrclingStill
            key={member.id}
            look={member.look}
            size={size}
            className="orcling-faces-face"
            cut={front ? { look: front.look, dx: 100 * (1 - OVERLAP), ring: (RING * 100) / size } : undefined}
          />
        );
      })}
    </span>
  );
}

/** A group's members standing together, alive, for its empty chat: the first three side by side, a little apart. */
export function OrclingGathering({ members, size = 144 }: { members: readonly Member[]; size?: number }) {
  return (
    <span className="orcling-gathering" style={{ "--figure": `${size}px` } as React.CSSProperties} aria-label={memberNames(members)}>
      {members.slice(0, 3).map((member) => (
        <OrclingPreview key={member.id} look={member.look} size={size} className="orcling-gathering-figure" />
      ))}
    </span>
  );
}

/** "Pip and Bo", "Pip, Bo and Rini": who a group chat is with. */
export function memberNames(members: readonly Pick<Orcling, "name">[]): string {
  return new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(members.map((member) => member.name));
}
