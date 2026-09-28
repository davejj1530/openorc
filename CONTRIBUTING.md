# Contributing to OpenOrc

Start with the [README](README.md), [product model](PRODUCT.md), and [architecture guide](ARCHITECTURE.md). For bugs, questions, and feature requests, see [SUPPORT.md](SUPPORT.md). Suspected vulnerabilities use the private route in [SECURITY.md](SECURITY.md).

## License and contributions

OpenOrc uses the [Apache License, Version 2.0](LICENSE). Unless explicitly stated otherwise, contributions intentionally submitted for inclusion are provided under that license, as described in Section 5. Only submit work you have the right to contribute, and retain applicable third-party copyright and license notices.

## Development setup

Use Node.js 24 and the pnpm version in `package.json`. CI runs every check on an Apple Silicon macOS runner, along with the performance benchmarks. On Windows Server 2025 it runs the size check, typecheck, script tests, and build, but not the test suite, because some tests rely on POSIX tools such as `/bin/sh`. Installers are built and checked only by the [release workflow](docs/desktop-updates.md). Linux is not a release target. The [README](README.md#project-status) lists the status of each platform.

```sh
pnpm install --frozen-lockfile
pnpm qa:onboarding --dev
```

The onboarding launcher creates a disposable application profile and removes it when the app exits. Add `--keep` to retain the profile for inspection. To work against your normal profile, use `pnpm dev`; quit any existing OpenOrc instance using that profile first. On macOS, `pnpm dev` uses the same data folder as an installed build but a different Keychain entry, so it cannot decrypt Slack credentials or the memory-extraction key saved by the installed app. See [credential storage](docs/credential-storage.md).

Electron, node-pty, ONNX Runtime, and sqlite-vec include platform-specific dependencies. Use a fresh install for the target platform. If native builds are required, install that platform's compiler tools; on macOS this is the Xcode Command Line Tools. The workspace's `allowBuilds` list controls dependency install scripts. Do not disable that list to work around a failed install; capture the failing dependency and command.

## Finding the right module

- Shared domain records, events, or RPC input: `packages/protocol`.
- Application behavior or permission decisions: `packages/core`.
- Provider protocol translation or process lifetime: `packages/agents`.
- Persistence, migrations, or transactional invariants: `packages/db`.
- Git operations and workspace integration: `packages/git`.
- Desktop windows, OS capabilities, and protected storage: `apps/desktop/src/main`.
- User interaction and rendering: `apps/desktop/src/renderer/src`.

Keep behavior close to the module that owns its invariants. Prefer a small interface that hides meaningful implementation details. Add an adapter seam when there are real alternative implementations, such as the provider adapters or a test transport. Avoid pass-through layers introduced only to make files shorter.

Read the [interface conventions](docs/design-system.md) before changing visual behavior. Preserve theme and composer behavior, and follow the Precision Outline icon specifications. Keep frontend behavior consistent during streaming and after history reload.

## Verification

Run the main checks from the repository root:

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm check:size
pnpm test
pnpm build
```

CI runs all of these. [Code quality checks](docs/code-quality.md) explains the lint, formatting, and size rules.

`pnpm test` runs the Vitest suites in `packages/agents`, `packages/core`, `packages/db`, `packages/git`, `packages/memory`, and `apps/desktop`, plus the `node:test` suites in `packages/mcp` and the website's changelog test in `apps/website`. CI also runs the size-limit, release, and notice script tests:

```sh
node --test scripts/size-limit.test.cjs scripts/distribution-notices.test.cjs scripts/desktop-release.test.cjs
```

The MCP server tests in `packages/mcp` use `node:test` through `tsx`. They run with `pnpm test` and in CI, or alone:

```sh
pnpm --filter @openorc/mcp test
```

For a focused change, run the affected package's checks first:

```sh
pnpm --filter @openorc/core typecheck
pnpm --filter @openorc/core exec vitest run src/services/fast-mode.test.ts
pnpm --filter @openorc/desktop test
```

Use `pnpm -r --no-bail test` to collect failures across packages when diagnosing a failing full run. Tests create disposable databases and repositories; a working Git installation is required. Core tests replace inherited provider paths with nonexistent synthetic paths for mocked adapters. Tests that exercise a real transport must override those paths with disposable fake provider executables; tests for missing discovery must explicitly clear them. This keeps developer CLI installations out of deterministic coverage. Restore environment overrides and adapter spies after each fixture. Tests should assert observable outcomes through the module's interface, including failure and recovery behavior when relevant.

For migrations, seed historical rows using that historical schema. Do not call current write interfaces against an old database or advance the fixture version just to make it pass. Verify upgrade, retained data, foreign keys, and reopening through the current database interface.

Format the files you changed using Prettier:

```sh
pnpm exec prettier --write path/to/changed-file.ts
pnpm exec prettier --check path/to/changed-file.ts
```

`pnpm format` rewrites the repository. Avoid whole-repository formatting in a focused change, especially when the checkout contains other work. Run `pnpm format:check` to confirm the repository is formatted.

`pnpm install` installs the Husky pre-commit hook. On each commit, lint-staged runs Prettier on staged files and stages its formatting changes. Unstaged edits are preserved, and unsupported formats and files in `.prettierignore` are skipped. The hook runs through `node --run precommit`, so it does not require a global pnpm shim. Full typecheck and tests stay in CI; run the relevant checks above before pushing. Git checks text files out with LF endings on every platform to match Prettier, while pinned third-party files retain their original bytes.

## Desktop and live-provider checks

Build the desktop before checks that load its production output:

```sh
pnpm --filter @openorc/desktop build
pnpm qa:onboarding
```

The scripts under `scripts/` have different fixtures and prerequisites; inspect the chosen script before running it. Prefer disposable profiles and fixture repositories. Never point destructive or restore tests at your everyday application data or a working repository.

Packages switch off Node's inspector, so there are two packaged checks. `pnpm qa:release /absolute/path/to/OpenOrc.app` checks a package as it ships: its fuses, its native code, and that it starts and ignores take-over switches. `pnpm qa:packaged` runs the deeper smoke on the package from `pnpm --filter @openorc/desktop package:smoke`, which keeps the inspector on; its first model check downloads MiniLM. Both use disposable data and disabled provider binaries. Exit code 2 from the smoke means native/model checks passed but OS credential verification is incomplete. See [packaged runtime validation](docs/packaged-runtime-validation.md) for build commands, coverage, and keychain limits.

Live-provider modes in the smoke tools can use your authenticated provider account and execute work. Run them deliberately against disposable repositories. Automated checks alone do not establish that a live provider still accepts the integration.

## Dependency notices and artwork

Run `pnpm licenses:check` after installing or upgrading dependencies. Electron 44 downloads its runtime on first module load. On a fresh install, first run `pnpm --filter @openorc/desktop exec node -e 'require("electron")'` to populate its runtime notices without opening the app. The desktop prepack hook and website build verify the manifest-listed versions and notice bytes. They do not inventory every new dependency: inspect the actual distribution using the separate commands in [the notice audit](docs/distribution-notices.md). A desktop audit exit code of 2 means missing notices or recorded package limitations remain; it is not complete clearance.

Retain original upstream text and review it before refreshing `licenses/manifest.json`. Do not format files under `licenses/vendor/` or the website public license directory. For artwork changes, update the source/generation record and [artwork provenance](docs/artwork-provenance.md); provider marks retain their own terms.

## Preparing a change for review

Explain the user-visible problem, the resulting behavior, and how you verified it. Include screenshots for visual changes and explicit limitations for checks you could not run. Keep commits focused and preserve unrelated work.

Do not include application databases, credentials, private conversation logs, or personal profile exports. Test secrets must be clearly synthetic. Keep generated QA output in ignored directories. Follow [SECURITY.md](SECURITY.md) for private vulnerability reporting; do not put sensitive vulnerability details or credentials in public issues.
