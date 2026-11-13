/** A rejected settings change leaves the previous selection intact, or fences a session whose state is uncertain. */
export async function withSettingsRollback(change: () => Promise<void>, restore: () => Promise<void>, close: () => void): Promise<void> {
  try {
    await change();
  } catch (error) {
    try {
      await restore();
    } catch {
      close();
    }
    throw error;
  }
}
