/** A capture that saw the workspace move under it can simply look again; anything else is a real failure. */
export const CAPTURE_RACE = /changed while its team snapshot was captured/;

export async function captureWithRetry<T>(operation: () => Promise<T>, options: { attempts?: number; delayMs?: number; assertActive?: () => void } = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      last = error;
      if (!(error instanceof Error) || !CAPTURE_RACE.test(error.message) || attempt === attempts) throw error;
      options.assertActive?.();
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 250));
    }
  }
  throw last;
}
