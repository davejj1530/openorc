# Dependency remediation

[pnpm-workspace.yaml](../pnpm-workspace.yaml) carries scoped compatibility and security fixes. Each patch, override, package extension, manifest, and the lockfile must travel together.

| Package                    | Change                                                                                                                                                             | Why                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| FastEmbed 2.1.0            | [Patch](../patches/fastembed@2.1.0.patch), `tar@7.5.22` override, native tokenizer removed by override, `@huggingface/tokenizers@0.2.0` added by package extension | Bounded archive extraction on tar 7 and a JavaScript MiniLM tokenizer |
| `@pierre/diffs` 1.4.2      | [Patch](../patches/@pierre__diffs@1.4.2.patch) to `dist/managers/ResizeManager.js`                                                                                 | Stops diff views from resizing inside the browser's resize callback   |
| nwsapi, under jsdom 26.1.0 | `nwsapi@2.2.28` override                                                                                                                                           | Stops a selector recursion in desktop tests                           |

## FastEmbed archive loading

FastEmbed 2.1.0 requests tar 6. Its ESM build also imports tar's default export, which tar 7 does not provide. Forcing only the version would break model initialization. The workspace therefore scopes a `tar@7.5.22` override to FastEmbed and applies the compatibility patch to both ESM and CommonJS builds.

The patch preserves FastEmbed's public interface and OpenOrc's existing Embedder behavior. It uses named tar exports, rejects extraction warnings, excludes archive links and special files, and bounds expanded input to 512 MiB and 256 ordinary entries. Tar's default path protections remain enabled. These limits accommodate OpenOrc's fixed `AllMiniLML6V2` model; evaluate them before selecting a different model.

Expanded bytes are counted before parsing, including padding after the tar end marker. Later padding is discarded instead of entering tar's buffer. The patch relies on tar 7.5.22's `eof` event, so keep the archive tests when upgrading. Nested gzip and zstd signatures are rejected before tar can automatically decompress a second layer beyond the byte counter.

## Model download

OpenOrc downloads the embedding model itself; FastEmbed's own download path is not used. [model-files.ts](../packages/memory/src/model-files.ts) pins the archive's URL (FastEmbed's fixed Qdrant Google Cloud Storage location), size, and SHA-256, plus a SHA-256 for each model file. Before each load, [the Embedder](../packages/memory/src/embedder.ts) checks every model file against its pin. If any file is missing or different, it removes the model folder, downloads the archive, and keeps it only if its size and SHA-256 match. FastEmbed then extracts that verified archive with the bounds above.

If the download or check fails, local embeddings are unavailable and memory search falls back to full-text search.

FastEmbed remains MIT-licensed. Tar 7.5.22 uses BlueOak-1.0.0; preserve its original license and the [third-party notices](../THIRD_PARTY_NOTICES.md).

## MiniLM tokenizer replacement

The FastEmbed patch replaces `@anush008/tokenizers@0.0.0` with the dependency-free JavaScript package `@huggingface/tokenizers@0.2.0`. The workspace removes the native dependency through an override and supplies the replacement through a package extension; the patched package manifest describes the resulting runtime dependencies too. Keep all three pieces with the lockfile.

Both module formats call one `lib/minilm-tokenizer.cjs` adapter in the patch. It accepts only the reviewed MiniLM WordPiece configuration, checks the special-token map and padding ID, reserves the template's special tokens before truncating content, and returns unpadded IDs, attention masks and type IDs with the model's `padId`. The patch also changes `FlagEmbedding.embed()` in both builds to right-pad each batch to its longest row; keep the adapter and that change together, because stock FastEmbed sizes its tensors from the first row. Other models and sparse embeddings are explicitly unsupported by this OpenOrc patch. This is narrower than upstream FastEmbed's advertised model list; OpenOrc already selects only MiniLM.

The replacement keeps the same model files, cache path, 512-token effective limit, `query: ` prefix, first-token vector extraction, normalization, and unavailable-model fallback, so stored vectors stay compatible. See [the comparison and scope](tokenizer-replacement.md); selecting another model or changing pooling requires a separate migration review.

## Diff view resize patch

The desktop diff viewer uses `@pierre/diffs` 1.4.2, which is Apache-2.0 licensed. Its `ResizeManager` updates column-width variables from a shared `ResizeObserver`. Those updates can reflow annotations and resize an ancestor while the browser is still delivering resize entries. The patch collects entries and applies them on the next animation frame, skips elements that are no longer connected, and cancels a pending frame when the last element stops being observed. Recheck the patch when upgrading the package.

## Test dependencies

The six Vitest workspaces use Vitest 4.1.11, which [the upstream mock-server advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9) lists as patched.

jsdom 26.1.0, a desktop test dependency, is pinned to `nwsapi@2.2.28` to prevent state-selector recursion through jsdom's `Element.matches` wrapper. It does not affect the shipped app.

## Verification and maintenance

Run the following sequentially from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @openorc/memory exec vitest run src/model-archive.test.ts src/model-files.test.ts
pnpm exec tsx scripts/memory-embedding-smoke.mts
pnpm -r --workspace-concurrency=1 --no-bail test
pnpm -r --workspace-concurrency=1 --no-bail typecheck
pnpm -r --workspace-concurrency=1 --no-bail build
pnpm audit --json
pnpm audit --prod --json
```

The archive tests use real FastEmbed initialization and extraction through both module formats, with synthetic cached archives. They cover successful extraction, traversal, hard/symbolic links, oversized entries, entry count, expanded bytes after EOF, malformed gzip, and nested compression. They stop at a deliberately missing tokenizer and require no network.

The separate embedding smoke downloads the real model into a disposable temporary directory. It checks initialization, finite normalized 384-dimensional vectors, batch ordering, repeatability, matching-text ranking, empty input, and reuse in a fresh process whose FastEmbed download path is disabled. It deletes its cache afterward and uses synthetic text. This is an online check, not part of the routine unit suite; it does not use an API key or a real application profile.

Run frozen installs when changing any patched or overridden dependency to prove patch application. Do not remove the FastEmbed patch while retaining the tar override, or vice versa, without proving upstream compatibility and rerunning both kinds of checks. Runtime checks and platform limits are documented in [packaged runtime validation](packaged-runtime-validation.md).
