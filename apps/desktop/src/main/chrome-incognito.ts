import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Return only an installed Chrome executable; never silently open a normal window. */
export function chromeExecutable(): string | null {
  const candidates = chromeCandidates();
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function openChromeIncognito(executable: string, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Separate argv keeps query strings and shell metacharacters literal.
    const child = spawn(executable, ["--incognito", "--new-window", url], { detached: true, stdio: "ignore", shell: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function chromeCandidates(): string[] {
  if (process.platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")];
  if (process.platform === "win32")
    return [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env["LOCALAPPDATA"]]
      .filter((root): root is string => Boolean(root))
      .map((root) => join(root, "Google/Chrome/Application/chrome.exe"));
  return (process.env["PATH"] ?? "/usr/bin:/usr/local/bin")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((root) => [join(root, "google-chrome"), join(root, "google-chrome-stable")]);
}
