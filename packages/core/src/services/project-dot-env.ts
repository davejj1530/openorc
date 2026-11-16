import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The variables in a .env file: KEY=value lines, `export` allowed, quotes taken off, \n in double quotes a line break,
 * a # after unquoted space a comment. Lines that set no variable are left out.
 */
export function parseDotEnv(text: string): { name: string; value: string }[] {
  const found = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    found.set(match[1]!, dotEnvValue(match[2]!));
  }
  return [...found].map(([name, value]) => ({ name, value }));
}

function dotEnvValue(rest: string): string {
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    const end = rest.indexOf(quote, 1);
    const inner = end === -1 ? rest.slice(1) : rest.slice(1, end);
    return quote === '"' ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"') : inner;
  }
  return rest.replace(/\s+#.*$/, "").trim();
}

/** The .env files a project's environment is filled from, in the order their values win. */
const ENV_FILES = [".env", ".env.local"];

/** What a project folder's .env files hold, the later file winning a name both set. Reads only; a missing file is none. */
export async function projectDotEnv(rootPath: string): Promise<{ files: string[]; entries: { name: string; value: string }[] }> {
  const files: string[] = [];
  const found = new Map<string, string>();
  for (const file of ENV_FILES) {
    const text = await readFile(path.join(rootPath, file), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (text === null) continue;
    files.push(file);
    for (const { name, value } of parseDotEnv(text)) found.set(name, value);
  }
  return { files, entries: [...found].map(([name, value]) => ({ name, value })) };
}
