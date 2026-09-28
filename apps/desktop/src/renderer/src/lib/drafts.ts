/** A synchronous local copy survives navigation before a server save completes. */
export function readDraft<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`openorc.draft.${key}`);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export function writeDraft<T>(key: string, value: T): boolean {
  try {
    localStorage.setItem(`openorc.draft.${key}`, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeDraft(key: string): void {
  try {
    localStorage.removeItem(`openorc.draft.${key}`);
  } catch {
    /* storage unavailable */
  }
}
