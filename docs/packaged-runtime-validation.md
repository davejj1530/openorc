# Packaged runtime checks

Two harnesses exercise a packaged macOS or Windows application with disposable data. Linux packages are not supported.

The shared packaging configuration filters ONNX Runtime, node-pty, and sqlite-vec binaries for each target: macOS arm64, macOS x64, or Windows x64. Filtering happens during copying, without deleting installed dependencies or their shared license notices, and applies to local, smoke, and release packages.

The before-pack hook also avoids shipping original copies of libraries already compiled into `out/`. [Runtime dependency filtering](../scripts/packaged-runtime-dependencies.cjs) keeps electron-updater, node-pty, sqlite-vec, FastEmbed, ONNX Runtime, and their installed production/optional/peer dependencies. AJV and ajv-formats remain available for generated validation code. Other dependencies retain package metadata and license/notice files, including nested notice folders. All compiled app chunks, workers, fonts, and WASM assets stay intact.

Before copying, an AST audit checks imports in the compiled main, preload, and renderer files. A new uncovered external import or nonliteral `require`/dynamic import stops packaging for review. When changing runtime imports, update the runtime roots if needed and rerun the packaged checks. The copy fixtures cover scoped and nested dependencies, notice preservation, unchanged development files, and the shared native/source-map exclusions.

Node WebGPU bindings (`webgpu/dist/*.dawn.node`) are excluded for every target. The orb renderer imports the browser entrypoint of `vgpu`, which uses Electron's built-in `navigator.gpu`; the app does not use `vgpu/node`. The browser animation code, Electron graphics engine, installed development dependencies, and package metadata/notices remain intact. The release inventory check rejects Node WebGPU bindings even when their OS and architecture match.

Debugging source maps (`*.map`) stay in the development checkout and any build output that generates them. The shared file-copy filter excludes them from packaged app output and dependencies; the release check rejects a package that still contains them. Development tooling and source-map generation settings are unchanged.

The same packaging filter excludes `cytoscape-fcose/demo/`, including nested dependency copies. These third-party example pages, sample graphs, and GIFs are not needed for Mermaid diagrams. Its runtime code remains in the compiled Mermaid chunks, its license remains included, and its installed development files remain on disk. The release check rejects packages that contain the demo folder.

- **The release check** runs on the package that ships, signed or not, from the outside. It reads the Electron fuses, checks where native code lives and, on a signed Mac package, who signed it, then starts the app and confirms that the switches another program could use to take it over do nothing.
- **The runtime smoke** covers the Electron renderer/preload/core bridge, the updater, native dependencies, local embedding models, restart and protected credential storage. It reads the main process through Node's inspector, which every shipped package switches off with a fuse, so it runs on the smoke package: the same build with only that fuse left on. Never distribute the smoke package.

## Run the checks

Use Node 24 and the repository's pnpm version:

```sh
pnpm --filter @openorc/desktop package
pnpm qa:release "$PWD/apps/desktop/release/mac-arm64/OpenOrc.app"

pnpm --filter @openorc/desktop package:smoke
pnpm qa:packaged "$PWD/apps/desktop/release-smoke/mac-arm64/OpenOrc.app"
```

Use the actual output path for the target platform and architecture. On macOS, pass the `OpenOrc.app` bundle. On Windows, pass the application directory that contains `OpenOrc.exe`, such as `win-unpacked` or an installed copy. [The release check](../scripts/packaged-release-check.cjs) fails on the smoke package by design, and [the smoke](../scripts/packaged-runtime-smoke.cjs) cannot read a shipped package.

Both create a temporary HOME, profile and Git repository through [one shared fixture](../scripts/fixtures/packaged-environment.cjs). Provider executable overrides point to inert fixtures, and credentials and memory text are synthetic. On macOS the temporary HOME gets its own empty, unlocked keychain: packages encrypt cookies with a key they read from the keychain at startup, and a HOME without one would stop at a "Keychain Not Found" dialog. macOS resolves the keychain list from HOME, so your own keychains are not read or changed. The smoke's first model load requires internet access. On macOS, the current user's login shell must be zsh, bash or sh, because the disposable HOME supplies startup files for those shells.

## Release check

| Check         | Assertion                                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fuses         | Running as Node, `NODE_OPTIONS` and `--inspect` are off; cookie encryption, asar integrity validation and loading only from the archive are on.                                  |
| Native code   | No `.node`, `.dylib`, `.so`, `.dll` or `.exe` is packed inside `app.asar`. On a signed Mac package, every Mach-O file carries the app's team, which library validation requires. |
| Native target | Dependency binaries match the runner's OS and processor. Required database, embedding, and terminal bindings/helpers are present; unused Node WebGPU bindings are absent.        |
| Startup       | The window loads, the core opens its ledger with `sqlite-vec`, and `--inspect` is ignored.                                                                                       |
| Take-over     | A launch with `ELECTRON_RUN_AS_NODE` runs no code, and a launch with `--remote-debugging-port` exits with an error before any window or debugging port opens.                    |

The release workflow runs it on the signed macOS app and the installed Windows app, then builds the smoke package from the same bundles. On Windows it runs the full smoke there; on macOS it runs only the [updater checks](#updater-only).

Cleanup targets only the launcher's processes and temporary directory. The ordinary desktop may remain running; existing profiles and repositories are not test inputs.

## Coverage and exit codes

| Check                         | Assertion                                                                                                                                                                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packaged startup              | `app.isPackaged`, renderer/preload startup and core RPC use the temporary profile.                                                                                                                                                                                |
| Updater                       | The native menu offers **Check for updates…** with automatic download and install disabled. A loopback feed with a harmless archive checks that checking does not download, a corrupt download is rejected, and a retry succeeds. The installer is never invoked. |
| Native PTY                    | A real shell emits a marker and exits successfully. On macOS it also reports the requested geometry.                                                                                                                                                              |
| SQLite/vector extension       | Core creates `memory_vec`; full-text fallback alone cannot pass.                                                                                                                                                                                                  |
| Cold model loading            | MiniLM downloads into the empty cache and semantic retrieval works without a literal word match.                                                                                                                                                                  |
| Offline cache reuse           | A separate Electron utility process imports packaged FastEmbed, uses the cache, and produces finite normalized 384-dimensional vectors while its HTTP/HTTPS/fetch calls are blocked. This is a loader-level check, not a machine-wide network block.              |
| Restart                       | A new packaged app retrieves persisted memory after bounded model warmup.                                                                                                                                                                                         |
| Protected storage unavailable | A false encryption-availability result requires save rejection without plaintext persistence. A timed-out probe reports incomplete coverage rather than asserting fail-closed behavior was tested.                                                                |
| Protected storage available   | Synthetic encryption, restart, replacement, clearing and absence of submitted plaintext are checked. On macOS, the credential file must also be owner-only. The key lives in the temporary HOME's keychain.                                                       |

- **0:** all exercised checks passed.
- **1:** an assertion, runtime operation or deadline failed.
- **2:** native/model/restart checks passed, but protected-storage coverage is incomplete. Read the printed `LIMIT`.

The storage probe runs last in a separate app instance with a 15-second availability deadline. The harness does not enable a plaintext backend or bypass prompts, and it never changes the current user's keychains.

## Updater only

Check startup and the updater without downloading a model:

```sh
pnpm qa:packaged /absolute/path/to/OpenOrc.app --updates-only
```

This mode runs the startup and updater checks above, then quits and reopens the app to confirm that an ordinary quit after a download leaves the installed version unchanged. The release workflow runs it on the smoke package of each macOS build. See [desktop updates](desktop-updates.md) for the installed-upgrade checks it does not replace.

## Protected storage only

Exercise protected storage without downloading a model. This mode runs only on macOS:

```sh
pnpm qa:packaged /absolute/path/to/OpenOrc.app --keychain-only
```

Four app instances check encryption with real `safeStorage`, mode `0600`, decryption, retention after restart, replacement, another restart, clearing and final absence. Neither submitted value may appear in the fixture database, WAL, encrypted file or captured logs. The encrypted empty clear marker must also decrypt correctly. The key sits in the temporary HOME's keychain, never in your login keychain: packages read the key at startup to encrypt cookies, so an app cannot switch to another keychain once it is running.

## Native extension paths

SQLite's native loader needs the physical library path under `app.asar.unpacked`, not Electron's virtual `app.asar` filesystem path. [Db](../packages/db/src/database.ts) resolves that path, and [electron-builder configuration](../apps/desktop/electron-builder.yml) unpacks the platform packages. Node source runs retain their ordinary paths. Unavailable extensions still permit database startup without vectors, but this smoke requires vector support.

## Verification limits

Run the release check against the actual release artifact; the smoke runs on its twin. Neither establishes signed-app keychain prompts, login-keychain behavior, encrypted-file portability, signing/notarization, Gatekeeper/quarantine installation, Windows publisher verification, Linux runtime behavior or live-provider compatibility.
