/**
 * Variables that make a shell, Node, Git or the dynamic loader run extra code. A program that launches OpenOrc can
 * set them, and every terminal, agent and Git command OpenOrc starts inherits its environment, so they are removed
 * once at startup. Values from the user's shell profile and Git config still apply: those files are read by the
 * shells and Git commands themselves, not inherited from the launcher.
 */
const injectedNames = new Set(["NODE_OPTIONS", "BASH_ENV", "ENV", "ZDOTDIR", "PROMPT_COMMAND", "LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH"]);
const injectedPrefixes = ["DYLD_", "GIT_"];

/** Deletes the injection variables from `env` in place and returns their names. */
export function removeInjectedVariables(env: NodeJS.ProcessEnv): string[] {
  const removed = Object.keys(env).filter((name) => injectedNames.has(name) || injectedPrefixes.some((prefix) => name.startsWith(prefix)));
  for (const name of removed) delete env[name];
  return removed.sort();
}
