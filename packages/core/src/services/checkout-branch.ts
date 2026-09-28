import { git } from "@openorc/git";

/** Read the checkout itself, including unborn branches; unavailable/detached HEAD has no branch. */
export async function checkoutBranch(cwd: string): Promise<string | null> {
  try {
    const result = await git(cwd, ["symbolic-ref", "--quiet", "HEAD"], { okCodes: [0, 1], timeoutMs: 2_000 });
    const ref = result.stdout.trim();
    return result.code === 0 && ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
  } catch {
    return null;
  }
}
