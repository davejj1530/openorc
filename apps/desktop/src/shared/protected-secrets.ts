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
} as const;

export type ProtectedSecretChannel = keyof typeof PROTECTED_SECRET_FILES;

export const PROTECTED_SECRET_CHANNELS = Object.keys(PROTECTED_SECRET_FILES) as ProtectedSecretChannel[];
