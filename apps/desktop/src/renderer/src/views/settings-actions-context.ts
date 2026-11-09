import { createContext } from "react";

/** The header target stays independent of component modules so live updates preserve its identity. */
export const SectionActionsSlot = createContext<HTMLElement | null>(null);
