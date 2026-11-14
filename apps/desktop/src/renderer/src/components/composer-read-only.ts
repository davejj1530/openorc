import { createContext, useContext } from "react";

/** All controls in a read-only composer share its reason, including controls supplied by a caller. */
export const ComposerReadOnly = createContext<string | null>(null);

export function useComposerControl(disabled?: boolean, reason?: string | null) {
  const readOnlyReason = useContext(ComposerReadOnly);
  return { disabled: Boolean(readOnlyReason || disabled), reason: readOnlyReason ?? reason ?? undefined };
}
