import type { Orcling } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { OrclingAvatar } from "./OrclingAvatar";

/** Several Orclings' faces overlapping, for a group chat: the first few, each cut out of the ground behind it. */
export function OrclingFaces({ members, size = 24, max = 3, className }: { members: readonly Pick<Orcling, "id" | "look" | "name">[]; size?: number; max?: number; className?: string }) {
  const shown = members.slice(0, max);
  return (
    <span className={cn("orcling-faces", className)} style={{ "--face": `${size}px` } as React.CSSProperties} aria-label={members.map((member) => member.name).join(", ")}>
      {shown.map((member) => (
        <OrclingAvatar key={member.id} orcling={member} size={size} className="orcling-faces-face" />
      ))}
    </span>
  );
}

/** "Pip and Bo", "Pip, Bo and Rini": who a group chat is with. */
export function memberNames(members: readonly Pick<Orcling, "name">[]): string {
  return new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(members.map((member) => member.name));
}
