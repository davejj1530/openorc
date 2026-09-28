# Credential storage

OpenOrc encrypts the credentials it saves with Electron `safeStorage`, which uses the macOS Keychain, Windows data protection, or the Linux secret service. Only the main process reads or writes them. Settings screens and usage views learn only whether a key is saved and see safe error messages, never the key itself.

The data folder holds two separate encrypted files:

- `memory-extraction-key.enc`: the optional Anthropic API key for memory extraction.
- `slack-secrets.enc`: Slack tokens and device settings (see [Slack](slack.md)).

The memory-extraction key is never written to the SQLite database. Each save writes a new owner-only file, syncs it to disk, replaces the old file, and on macOS and Linux syncs the folder before reporting success. Saves to the same file happen one at a time. Linux's `basic_text` backend, which does not encrypt, is refused. Reading a missing file needs no keychain access; saving or reading a key needs working OS protection.

## Where the data lives

The data folder is in the OS application data directory (`~/Library/Application Support/OpenOrc` on macOS). Set `OPENORC_USER_DATA` to use a different one.

Packaged builds store their encryption key under the name `OpenOrc`, and development builds under `@openorc/desktop`, so the two cannot read each other's credentials. A change of macOS signing identity may ask for Keychain approval again. See [Electron's encryption initialization](https://github.com/electron/electron/blob/v44.3.0/shell/browser/electron_browser_main_parts.cc#L591).

Encrypted files only open with the same OS account and encryption key. Copying them to another machine is not a way to back up credentials.

## Saving and removing the key

Open **Settings → Memory & models → Learn from completed runs** and choose **Anthropic API key** as the provider. The key field appears after that choice; the provider list is available while memory is on. The saved key is never shown in the field. Removing the key saves an encrypted empty value. Diagnostic logs leave out memory settings.

If protected storage is locked or unavailable, key-based extraction is unavailable and Settings shows what to do. Unlock the OS keychain or secret service, then use **Retry storage** or **Retry save**. A failure before the file is replaced keeps the previous value. If only the final sync fails, the new file may already be in place; save again to be sure. **Off** and subscription-based extraction stay available, and OpenOrc never falls back to saving the key unencrypted.

## For contributors

Tests use disposable databases, real file writes and permissions, interrupted saves, concurrent requests, safe RPC responses and logging, the usage view, and settings recovery. They replace Electron's encryption with a test implementation.

The [packaged runtime check](packaged-runtime-validation.md) runs a real package. When OS encryption is unavailable, it checks that saving is refused. When it is available, it checks real encryption, restart, replacement, and clearing. On macOS, `--keychain-only` repeats that lifecycle across four app instances in a temporary keychain inside a disposable home folder; your login keychain is never read or changed. All credentials and app data in these checks are synthetic. They do not cover keychain prompts for signed builds or Linux secret services.
