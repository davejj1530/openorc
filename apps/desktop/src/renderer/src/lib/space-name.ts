import type { Space } from "@openorc/protocol";

/** What the person's own space is called wherever spaces are named. */
export const PERSONAL_SPACE = "My workspaces";

export const spaceName = (space: Space): string => (space.kind === "personal" ? PERSONAL_SPACE : space.name);
