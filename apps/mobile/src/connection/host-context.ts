import { createContext } from "react";

/** Which host a screen talks to: the shown one unless a scope names its partner. */
export const HostContext = createContext<string | null>(null);
