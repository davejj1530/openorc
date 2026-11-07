import { signInPrint, type HandoverValues } from "@openorc/cloud";
import type { ProtectedSecretStore } from "@openorc/core";

type GitHubSignIn = NonNullable<HandoverValues["github"]>;

/** Its sealed file's channel: the brain's own, beside the core's (secrets.ts), and apart from the reviewer app's "github". */
export const GITHUB_CHANNEL = "github-sign-in";
/** A remote in either ssh form reaches GitHub over https instead: the brain has the Mac's token and no ssh key. */
const SSH_FORMS = ["git@github.com:", "ssh://git@github.com/"];
/** A helper of git's own shell, so git reads the token from its own environment and never from a file. */
const HELPER = '!f() { if test "$1" = get; then printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; fi; }; f';

/** What git and gh read the sign-in from: gh its token, git a credential helper and the Mac's author. */
export function githubEnvironment(signIn: GitHubSignIn | null): Record<string, string> {
  if (!signIn) return {};
  const config: [string, string][] = [
    ["credential.https://github.com.helper", HELPER],
    ...SSH_FORMS.map((form): [string, string] => ["url.https://github.com/.insteadOf", form]),
    ...(signIn.name ? [["user.name", signIn.name] as [string, string]] : []),
    ...(signIn.email ? [["user.email", signIn.email] as [string, string]] : []),
  ];
  const entries = config.flatMap(([key, value], index) => [
    [`GIT_CONFIG_KEY_${index}`, key],
    [`GIT_CONFIG_VALUE_${index}`, value],
  ]);
  return { GH_TOKEN: signIn.token, GIT_CONFIG_COUNT: String(config.length), ...Object.fromEntries(entries) };
}

/**
 * The Mac's GitHub sign-in on the brain: sealed on its disk, and in memory for the git and gh commands the core runs,
 * to commit, push and open pull requests from the brain's copy of each thread. No other program the brain starts gets
 * it, and thread sandboxes never do.
 */
export class BrainGitHub {
  private signIn: GitHubSignIn | null = null;

  constructor(
    private readonly store: ProtectedSecretStore,
    private readonly warn: (text: string) => void,
  ) {}

  /** At start. A sign-in that cannot be read is off, so the brain still starts, and the Mac's next wake sends it again. */
  async load(): Promise<void> {
    try {
      const saved = await this.store.load();
      this.signIn = saved ? (JSON.parse(saved) as GitHubSignIn) : null;
    } catch {
      this.signIn = null;
      this.warn("The GitHub sign-in could not be read, so it is off until the Mac sends it again.");
    }
  }

  /** Null deletes it. */
  async set(signIn: GitHubSignIn | null): Promise<void> {
    await this.store.save(signIn ? JSON.stringify(signIn) : "");
    this.signIn = signIn;
  }

  environment(): Record<string, string> {
    return githubEnvironment(this.signIn);
  }

  /** Names the one it holds, as the Mac names the one it sent; null without one. */
  print(): string | null {
    return this.signIn && signInPrint(this.signIn);
  }
}
