import { createContext, useContext, type ReactNode } from "react";

const ClaudeAccountContext = createContext<string | undefined>(undefined);

export function ClaudeAccountScope({ id, children }: { id: string | undefined; children: ReactNode }) {
  return <ClaudeAccountContext.Provider value={id}>{children}</ClaudeAccountContext.Provider>;
}

export function useClaudeAccountId(): string | undefined {
  return useContext(ClaudeAccountContext);
}
