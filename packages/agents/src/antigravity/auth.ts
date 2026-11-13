import { stripAnsi } from "../jsonrpc.js";

/** `agy models` checks the cached login without starting interactive authentication or a model turn. */
export function antigravityAuthenticated(output: string, env: Readonly<NodeJS.ProcessEnv> = {}): boolean | null {
  // `models` only reads the Google login. ACP can separately authenticate with the key in its launch environment.
  if (env["GEMINI_API_KEY"]?.trim()) return true;
  const text = stripAnsi(output);
  if (/please sign in|authentication required|not (?:signed|logged) in/i.test(text)) return false;
  return /\bgemini-[\w.-]+/i.test(text) ? true : null;
}
