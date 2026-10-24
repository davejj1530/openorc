/** Why something failed, in the words the Mac or the phone gave. */
export const failureMessage = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));
