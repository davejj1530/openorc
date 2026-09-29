# Desktop releases and updates

## Updating OpenOrc

Installed macOS and Windows releases update from public GitHub Releases. On macOS, use **OpenOrc → Check for updates…**; on Windows, use **Help → Check for updates…**. OpenOrc also checks 30 seconds after it starts and every six hours. To stop the automatic checks, turn off **Check for updates automatically** in Settings → General → Updates. Development builds and local packages without an update feed never check.

When a newer release is found, an in-app notice offers **Download update** or **Later**. Downloading shows progress, then **Restart to update**. Both downloading and restarting require your action. If OpenOrc is in the background, it also attempts one silent desktop notification per version; clicking it brings the app and update notice forward. Desktop delivery depends on operating-system notification permissions. The in-app notice works independently of those permissions.

**Later** dismisses that version across windows and restarts, but the native update menu remains available. Starting a download from the menu brings progress back into view. Notification history and dismissal are saved independently of the automatic-check setting. A newer version can prompt again. Download failures offer a retry; a restart blocked by active work explains what needs to finish.

**Hide** on a download notice hides its progress until the update is ready, without cancelling the download. A failed-install notice can also be hidden so you can finish your work before quitting and reopening the app.

Checks continue after choosing **Later** for an undownloaded release, so a newer release can appear without restarting OpenOrc. If a later check fails, the previously found version remains available to download from the notice or the native menu.

Linux installs do not update themselves yet, and Settings → General → Updates says so. Install each new version from its release: `sudo dnf install ./OpenOrc-….rpm` or `sudo apt install ./OpenOrc-….deb` upgrades the installed package in place, and a newer AppImage replaces the old file. Your data folder stays where it is.

Published stable and beta releases are offered to everyone when their version is newer than the installed version. Drafts are not offered, and the updater never downgrades. Every release must use a higher version number.

Versions through `0.1.0-beta.4` shipped with stable-only checks. Those installations need a one-time manual installation of the first beta containing this change, or an update to a newer stable release, before they can receive future beta updates.

Restarting to install waits until nothing is in progress: agent turns, approvals, context maintenance, unfinished teams, pending requests, scheduled runs that are starting, memory processing, coding-agent updates, and running terminal panels. Idle agent sessions close normally. Once the app agrees, it holds new agent turns and terminals, finishes writing its data, and waits for the core process to exit cleanly before the installer starts. OpenOrc never stops a running agent to force an update. If shutdown cannot be confirmed or the installer fails, quit and reopen the app before trying again.

Updates keep the app ID (`app.openorc.desktop`), the OpenOrc name, and your data folder. Uninstalling on Windows also keeps your data. Quitting after a download does not install the update.

## Publishing a release (maintainers)

### Configure the release repository

Releases are built and published from the public repository named by the `RELEASE_REPOSITORY` Actions variable (`owner/name`). The release workflow must run in that repository: it rejects a run from any other repository, and electron-builder embeds that repository in every installer as the update feed. Never ship a GitHub token in the app.

Run `.github/workflows/release.yml` (**Desktop release**) from the Actions tab. It validates the tag and repository, builds and checks the installers, and can attach them to a draft release. It never publishes a release. The release environment needs:

| Kind     | Name                                                           | Value                                                                                           |
| -------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Variable | `RELEASE_REPOSITORY`                                           | This repository's `owner/repository`; set at repository level so the validation job can read it |
| Variable | `MAC_SIGNING_IDENTITY`                                         | Full `Developer ID Application: …` certificate identity                                         |
| Variable | `WINDOWS_PUBLISHER_NAME`                                       | Publisher name matching the Windows signing certificate                                         |
| Secret   | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`                         | Exported macOS signing certificate (base64) and password                                        |
| Secret   | `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | App Store Connect notarization API key and identifiers                                          |
| Secret   | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`                         | Windows signing certificate (base64) and password                                               |

Keep certificates and keys in CI secrets. The workflow writes the notarization key to the runner's temporary folder and removes it afterwards. The Windows configuration signs with a certificate file; organizations using hardware or cloud signing should replace that part before releasing. Signing and notarization follow [electron-builder v26's signing configuration](https://www.electron.build/v26/docs/features/code-signing/).

### Build and publish

1. Set `apps/desktop/package.json` to a non-zero version, such as `0.1.0` or `0.1.0-beta.1`. Once CI passes, commit the change and push its matching tag, such as `v0.1.0-beta.1`. Never move an existing release tag.
2. Run **Desktop release** for that tag. The workflow pins its commit and builds on native macOS arm64, macOS x64, Windows x64, and Linux x64 runners. It requires macOS signing and notarization, and normally requires Windows signing; Linux packages are not code-signed. It builds macOS DMG and ZIP files, Windows NSIS installers, and a Linux AppImage, deb and rpm, checks packaged startup and update behavior, and installs the Windows candidate and the Linux deb on their disposable runners before uploading artifacts.
3. Enable **create_draft** to attach successful builds, update metadata, and `SHA256SUMS.txt` to a new draft release. Existing releases are not overwritten. Download the assets and complete the checks under [Before publishing](#before-publishing). Review the tag and update destination. In the draft's notes, replace the comment under **Highlights** with 2 to 5 user-facing bullets and check the **Install notes**, then publish on GitHub. The website changelog shows those highlights once the release is public.
4. Keep all installer, ZIP, blockmap, and update YAML assets. The channels are `latest-arm64` and `latest-x64`, so each macOS architecture has its own metadata file (`latest-arm64-mac.yml`, `latest-x64-mac.yml`); Windows uses `latest-x64.yml` and Linux `latest-x64-linux.yml`, which installed Linux builds do not read yet. This keeps parallel builds from overwriting each other's update feed. electron-builder embeds the channel and release repository in `app-update.yml`. The updater preserves this architecture-specific channel when discovering both stable and beta releases. Do not change it or the repository after shipping without a migration plan.

The [electron-builder update guide](https://www.electron.build/v26/docs/features/auto-update/) explains the metadata and why macOS needs the ZIP.

For packaging problems, **windows_only** runs just the Windows job. It cannot create a draft: a draft needs successful builds and checks for all four platform and architecture combinations.

### Unsigned Windows beta

A beta tag such as `v0.1.0-beta.1` can opt into **unsigned_windows_beta**. The workflow sets `OPENORC_UNSIGNED_WINDOWS_BETA` to that exact package version. Stable versions and mismatched exceptions are rejected. Without this option, Windows signing credentials are required. macOS always requires signing and notarization.

The Windows installer filename includes `-unsigned`, and the draft release notes say so. It has no verified Windows publisher. Windows may warn about an unrecognized app or block it under stricter policies. Keep that notice beside the website's Windows beta download. Do not describe checksums or build attestations as Windows signing.

Beta tags create prereleases, which updated installations offer alongside stable releases. Draft assets are visible only to people with write access to the repository, and installed apps see a release only after it is published. No access token is embedded in the application.

For a local Windows beta build, set `OPENORC_UNSIGNED_WINDOWS_BETA` to the beta package version along with `RELEASE_TAG` and `OPENORC_RELEASE_REPOSITORY`. Executable icon and version editing still run; only Authenticode signing is skipped.

For local unsigned packages, use `pnpm --filter @openorc/desktop package`. On Linux, `pnpm --filter @openorc/desktop package:linux` builds the AppImage, deb and rpm without an update feed; the rpm needs `rpmbuild` (the `rpm-build` package on Fedora, `rpm` on Debian and Ubuntu). For a signed native release outside CI, provide the same variables (use `CSC_LINK` and `CSC_KEY_PASSWORD` for the macOS certificate and `APPLE_API_KEY` for the path of a temporary `.p8` file), set `RELEASE_TAG` and `OPENORC_RELEASE_REPOSITORY`, then run `pnpm --filter @openorc/desktop release:build`. It also uses `--publish never`.

### Before publishing

Automated tests cover the update policy, concurrent actions, retryable network errors, progress, refusing to install while work is running, holding new turns and terminals, and requiring a clean exit of the core process. Release configuration tests reject missing signing inputs, malformed repositories, placeholder versions, and mismatched tags. Run them with `node --test scripts/desktop-release.test.cjs`.

On macOS or Windows, the smoke package can also run the real updater against a disposable local feed. The smoke reads the app through Node's inspector, which only the smoke package allows, so it does not work on a release or ordinary local package:

```sh
pnpm --filter @openorc/desktop package:smoke
node scripts/packaged-runtime-smoke.cjs "$PWD/apps/desktop/release-smoke/mac-arm64/OpenOrc.app" --updates-only
# On Windows, pass the unpacked application folder that contains OpenOrc.exe.
```

This uses a disposable profile and a harmless download to check update metadata, explicit downloads, rejection of a bad checksum, retry, and quitting and reopening without installing. It never runs the installer or touches your own profile. See [packaged runtime checks](packaged-runtime-validation.md) for the full smoke.

These checks do not replace a real upgrade between two installed versions. Before publishing:

- Install the older release from its DMG or NSIS installer; on macOS, check Gatekeeper and notarization. For signed Windows releases, check the expected publisher; for an unsigned beta, check the notice and record how Windows security responds.
- Publish a newer test version to a dedicated public test repository configured in test builds. Check that it is offered, that an interrupted download can be retried, and that the right architecture's installer is used.
- Try restarting during an agent turn, a pending approval, active team work, and a running terminal. Each must keep running with a clear refusal. Finish that work and try again.
- Install from an idle state, then check the restart, version, existing conversations, settings, credentials, agent discovery, native SQLite and ONNX loading, and terminals.
- Check that quitting after a download does not install the update, and that an unavailable feed or invalid signature leaves the previous installation usable.

This final test needs a controlled test feed and two real installer versions. An unsigned Windows beta cannot confirm the publisher certificate; check the publisher separately for signed Windows releases.

### Notices

The dependency audit reports a [documented notice exception](distribution-notices.md) for `lazy-val` 1.0.5, which `electron-updater` uses. Its original MIT and author metadata are kept, and the missing upstream copyright and license text is disclosed. This exact-version exception does not block the release workflow. Other unresolved notices, changed evidence, and recorded native limitations still fail the packaged artifact audits and prevent draft creation.

Electron 44.3.0 ships different Chromium notices on Windows and macOS. The manifest pins each platform's original file separately; the Windows file also includes the MIT-licensed Windows WebAuthn API headers and keeps upstream CRLF line endings. Linux's file is byte-identical to macOS's. Source and packaged copies must match the reviewed hash for their platform.
