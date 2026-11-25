import { settings, type Db } from "@openorc/db";
import type { z } from "zod";

/**
 * Answers an agent takes seconds to give, kept in the settings table so the next start shows the last one while it asks
 * again. A row this version cannot read counts as none.
 */
export interface Kept<T> {
  read(name: string): T | undefined;
  write(name: string, value: T): void;
}

export function keptAnswers<T>(db: Db, kind: string, shape: z.ZodType<T>): Kept<T> {
  return {
    read(name) {
      const raw = settings.get(db, `${kind}:${name}`);
      if (raw === null) return undefined;
      try {
        const value: unknown = JSON.parse(raw);
        // The value as it was written, not as the shape rebuilds it, so it compares equal to the same answer given again.
        return shape.safeParse(value).success ? (value as T) : undefined;
      } catch {
        return undefined;
      }
    },
    write: (name, value) => settings.set(db, `${kind}:${name}`, JSON.stringify(value)),
  };
}
