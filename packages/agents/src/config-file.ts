import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

/** Changes one value in a configuration file the user may have written by hand, leaving their comments and order alone. */
export function editedConfig(text: string, at: string[], value: unknown): string {
  return applyEdits(text, modify(text, at, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
}

/** A JSON or JSONC configuration file's text and value; a missing file reads as an empty object. */
export async function readConfigFile(file: string, unreadable: string): Promise<{ text: string; value: Record<string, unknown> }> {
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? "{}\n" : Promise.reject(error)));
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) throw new Error(unreadable);
  return { text, value: value as Record<string, unknown> };
}

/** Writes the whole file at once. A configuration kept elsewhere behind a link, as dotfiles often are, is written where it lives. */
export async function replaceFile(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const target = await realpath(file).catch(() => file);
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { mode });
  await rename(temporary, target);
}
