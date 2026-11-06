# Roadmap

OpenOrc is under active development. The desktop supports conversations, task documents, provider integrations, local memory, and Git review, and the iPhone app drives the same threads from a paired phone. Cloud threads and the cloud brain run in development and QA builds. See the [README](README.md) for setup and the [product model](PRODUCT.md) for behavior.

## Reliability and platform support

- Keep contributor installation and automated checks reproducible with disposable provider and repository fixtures.
- Exercise onboarding, task editing, streaming/replay, keyboard navigation, and narrow layouts with the production renderer.
- Complete signed/notarized macOS installation and upgrade checks, including OS-protected credential storage.
- Validate Intel macOS, Windows and Linux runtime behavior beyond the release workflow's packaged checks, including installation on Fedora and native Wayland sessions.
- Let installed Linux builds update themselves, starting with the AppImage.
- Review dependency notices and provider-asset presentation whenever versions or artwork change.

The [packaged runtime checks](docs/packaged-runtime-validation.md) describe the macOS, Windows and Linux harnesses and their limits. No release date or support guarantee is implied by these priorities.

## Phone and cloud

- Offer cloud threads and the cloud brain in release builds once each agent has run a real turn on Vercel and on Agent37 with its sign-in kept outside the sandbox where the service allows it.
- Set up the cloud brain from the phone alone, without the desktop.
- Keep App Store builds of the phone working against newer desktops by gating each new event or result per phone and testing against the installed builds' readers.

## Architecture priorities

1. Move provider model discovery, revision-aware caching, retries, and eligibility into a model catalog.
2. Concentrate shared task-admission and authorization invariants behind a small interface used by RPC and MCP.
3. Give cache invalidation tags a shared typed vocabulary.

Improve one cohesive module at a time, with observable benefits and regression coverage. The [architecture guide](ARCHITECTURE.md) explains the existing responsibilities.
