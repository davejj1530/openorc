# Roadmap

OpenOrc is under active development. The desktop supports conversations, task documents, provider integrations, local memory, and Git review. Team execution is in Beta and enabled for new profiles (**Team execution (Beta)** in Settings); existing choices are preserved. See the [README](README.md) for setup and the [product model](PRODUCT.md) for behavior.

## Reliability and platform support

- Keep contributor installation and automated checks reproducible with disposable provider and repository fixtures.
- Exercise onboarding, task editing, streaming/replay, keyboard navigation, and narrow layouts with the production renderer.
- Complete signed/notarized macOS installation and upgrade checks, including OS-protected credential storage.
- Validate Intel macOS, Windows and Linux runtime behavior beyond the release workflow's packaged checks, including installation on Fedora and native Wayland sessions.
- Let installed Linux builds update themselves, starting with the AppImage.
- Review dependency notices and provider-asset presentation whenever versions or artwork change.

The [packaged runtime checks](docs/packaged-runtime-validation.md) describe the macOS, Windows and Linux harnesses and their limits. No release date or support guarantee is implied by these priorities.

## Architecture priorities

1. Move provider model discovery, revision-aware caching, retries, and eligibility into a model catalog.
2. Concentrate shared task-admission and authorization invariants behind a small interface used by RPC and MCP.
3. Give cache invalidation tags a shared typed vocabulary.

Improve one cohesive module at a time, with observable benefits and regression coverage. The [architecture guide](ARCHITECTURE.md) explains the existing responsibilities.
