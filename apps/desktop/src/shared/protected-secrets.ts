/**
 * The protected stores the core may ask main for, each with the encrypted file main keeps it in. Main serves only
 * these channels, and the core's client can name only these.
 */
export const PROTECTED_SECRET_FILES = {
  "slack.secrets": "slack-secrets.enc",
  "memory.secrets": "memory-extraction-key.enc",
  "github.secrets": "github-reviewer-app.enc",
  /** The Mac's static key pair for phone access. */
  "remote.secrets": "remote-access-key.enc",
  /** The Apple push key phone alerts are signed with, as the user added it. */
  "push.secrets": "apns-key.enc",
  /** The Vercel connection cloud threads run on. */
  "cloud.secrets": "cloud-credentials.enc",
  /** Each Claude account's token for signing in to cloud sandboxes. */
  "claude-cloud.secrets": "claude-cloud-tokens.enc",
  "codex-cloud.secrets": "codex-cloud-login.enc",
  /** OpenCode's provider keys entered for the cloud. */
  "opencode-cloud.secrets": "opencode-cloud-keys.enc",
  /** The cloud brain's key, team and region. */
  "cloud-brain.secrets": "cloud-brain.enc",
  /** A new cloud brain's, set up on the other service while the brain moves there. */
  "cloud-brain-move.secrets": "cloud-brain-move.enc",
} as const;

export type ProtectedSecretChannel = keyof typeof PROTECTED_SECRET_FILES;

export const PROTECTED_SECRET_CHANNELS = Object.keys(PROTECTED_SECRET_FILES) as ProtectedSecretChannel[];
