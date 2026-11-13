# Roadmap

OpenOrc is under active development. The desktop runs on macOS, Windows, and Linux, with conversations, task documents, Orclings, provider integrations, local memory, and Git review. The iPhone app, on the App Store, drives the same threads, tasks, and Orclings from a paired phone. Cloud threads and the cloud brain run on the user's own Vercel or Agent37 account. See the [README](README.md) for setup and the [product model](PRODUCT.md) for behavior.

## Reliability and platform support

- Keep contributor installation and automated checks reproducible with disposable provider and repository fixtures.
- Exercise onboarding, task editing, streaming/replay, keyboard navigation, and narrow layouts with the production renderer.
- Complete signed/notarized macOS installation and upgrade checks, including OS-protected credential storage.
- Run the test suite on Windows. Its POSIX-only fixtures keep it on macOS and Linux today.
- Bring Windows level with macOS and Linux: Plan and Accept edits for Claude Code, project setup scripts, agent updates from Settings, and signed installers.
- Add Fedora installs and native Wayland sessions to the Linux release checks, and exercise Intel macOS beyond packaged startup.
- Let installed Linux builds update themselves, starting with the AppImage.
- Review dependency notices and provider-asset presentation whenever versions or artwork change.

The [packaged runtime checks](docs/packaged-runtime-validation.md) describe the macOS, Windows and Linux harnesses and their limits. No release date or support guarantee is implied by these priorities.

## Phone and cloud

- Set up the cloud brain from the phone alone, without the desktop.
- Keep App Store builds of the phone working against newer desktops by gating each new event or result per phone and testing against the installed builds' readers.

## Architecture priorities

1. Move provider model discovery, revision-aware caching, retries, and eligibility into a model catalog.
2. Concentrate shared task-admission and authorization invariants behind a small interface used by RPC and MCP.
3. Give cache invalidation tags a shared typed vocabulary.

Improve one cohesive module at a time, with observable benefits and regression coverage. The [architecture guide](ARCHITECTURE.md) explains the existing responsibilities.
