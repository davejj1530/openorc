# Third-party notices

OpenOrc's Apache-2.0 license covers its original work. Dependencies, fonts, trademarks, and vendored code retain their own terms. This inventory identifies reviewed third-party material; it is not a complete license manifest for every transitive dependency.

## Vendored orb runtime and shaders

The orb renderer and React canvas under `apps/desktop/src/renderer/src/components/orbs/` were adapted from [shadercn](https://github.com/shadcn-labs/shadercn). The runtime's MIT license, Copyright (c) 2026 Shadcn Labs, is reproduced in [licenses/shadercn-MIT.txt](licenses/shadercn-MIT.txt). The license text was retrieved from upstream commit `edf7412ac6f7b377b695ca2b2d14535a3be85d44`; this identifies the license evidence, not the original import revision.

OpenOrc modified the runtime for TypeScript checking, animation lifecycle, and local rendering behavior. The [vendored README](apps/desktop/src/renderer/src/components/orbs/README.md) lists these changes.

The conversation indicator uses the original Apache-2.0 Hollow shader in `orbs/hollow/`. The shader and the MIT renderer retain their separate terms.

The original Rive mascot and its source availability are described in [the mascot record](assets/mascot/README.md).

## Fonts

| Font package                          | Reviewed version | Terms and distribution                                                                                                                                                      |
| ------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@fontsource-variable/inter`          | 5.3.0            | SIL OFL 1.1; original copyright and license are retained in the desktop archive's package directory.                                                                        |
| `@fontsource-variable/jetbrains-mono` | 5.3.0            | SIL OFL 1.1; original copyright and license are retained in the desktop archive's package directory and published at `/licenses/jetbrains-mono-OFL-1.1.txt` on the website. |
| `@fontsource-variable/geist`          | 5.3.0            | SIL OFL 1.1; original copyright and license are retained in the desktop package.                                                                                            |

These font files remain under OFL rather than Apache-2.0. Preserve their license files and any reserved-font-name requirements when replacing or modifying them.

The website and desktop app's Immaculate Gothic Text and Bold faces are David's custom font from family package 1.101. Their supplied provenance is preserved in `licenses/vendor/immaculate-gothic-PROVENANCE.txt`, published at `/licenses/immaculate-gothic-PROVENANCE.txt`, and included in the desktop app's `licenses/vendor/` resources. The font is separate from the Apache-2.0 code license; its package does not assign an open-source license. See the [font record](apps/website/src/assets/fonts/README.md) for file hashes and use.

## Dependency notices

The desktop package retains dependency license files inside `app.asar/node_modules`, including `khroma@2.1.0/license`. Khroma's package manifest omits a license field, but its shipped license is MIT, Copyright (c) 2019-present Fabio Spampinato, Andrew Maney.

The installed dependency graph is broader than the shipped application. Website image processing uses libvips under LGPL-3.0-or-later; CSS tooling includes Lightning CSS under MPL-2.0. Neither package was present in the inspected macOS desktop archive or the static website output. Reassess their obligations if distributing a different artifact, container, native platform, or dependency bundle. Package metadata alone is not evidence of inclusion or complete compliance.

Electron's MIT license and Chromium notice collection accompany the app under `licenses/electron/`. Supplemental sqlite-vec, ONNX Runtime, Rive, and JavaScript dependency notices are preserved under `licenses/vendor/`, including MIT sections otherwise stripped with package READMEs. [The manifest](licenses/manifest.json) records pinned sources, reviewed versions, hashes, and artifact destinations.

Additional Rive notices preserve borrowed Skia source, libhydrogen, Microsoft and Unicode shaping data, and Emscripten runtime collections. Historical tokenizer notices preserve 68 sections for 34 crate versions evidenced in the former Darwin binary. [Native notice evidence](docs/native-notice-evidence.md) and the source inventories under `licenses/` distinguish reviewed texts from complete binary inventories.

The native `@anush008/tokenizers` dependency has been replaced by **`@huggingface/tokenizers@0.2.0`**, an Apache-2.0 JavaScript implementation. Its original license is preserved at `licenses/vendor/huggingface-tokenizers-Apache.txt`. The [MiniLM adaptation](docs/tokenizer-replacement.md) preserves the existing model and inference behavior. The old native notices remain historical evidence; they do not imply that those binaries are still distributed or that their complete compiled inventory was established.

FastEmbed 2.1.0 retains its MIT license, Copyright (c) 2023 Anush. OpenOrc patches its ESM and CommonJS archive loader for tar 7 compatibility and bounded extraction, and replaces its tokenizer with an adapter limited to OpenOrc's reviewed MiniLM configuration; see [the patch record](docs/dependency-remediation.md). Preserve FastEmbed’s original `LICENSE` when distributing the patched package. Gearhash-jit's supplemental MIT text comes from its published Hugging Face monorepo revision.

The patched loader uses `tar@7.5.22` under the [Blue Oak Model License 1.0.0](https://blueoakcouncil.org/license/1.0.0). Its original `LICENSE.md` must remain with distributed copies (or accompany them with that license link). These third-party packages retain their own terms.

`@pierre/diffs` 1.4.2 is used under Apache-2.0. OpenOrc modifies its `dist/managers/ResizeManager.js` so resize work runs on the next animation frame and skips detached elements; the change is [patches/@pierre\_\_diffs@1.4.2.patch](patches/@pierre__diffs@1.4.2.patch) and is described in [the patch record](docs/dependency-remediation.md). The package's original `LICENSE.md` is retained.

## Desktop updater

The desktop updater uses `electron-updater` 6.8.9 under MIT, Copyright (c) 2015 Loopline Systems. Its original LICENSE is preserved in the application archive and checked by the distribution manifest.

Its dependency `lazy-val` 1.0.5 declares MIT and names Vladimir Krivosheev as author, but the published package and its npm source commit contain no copyright/license text. The original package metadata is retained in `licenses/vendor/lazy-val-1.0.5.package.json`; it is evidence of the declaration, not a replacement for the missing notice. OpenOrc retains this dependency under a documented notice exception for version 1.0.5. The artifact audit reports the omission and verifies the preserved metadata and packaged author/license declaration. The exception does not supply the missing upstream notice; any upgrade requires another review.

## Brand and artwork provenance

- Project framework and language logos are a selected set of SVGs from Devicon v2.17.0, Copyright (c) 2015 konpa, under the MIT license. The original notice is preserved in [licenses/vendor/devicon-MIT.txt](licenses/vendor/devicon-MIT.txt); pinned sources and hashes are recorded beside the assets. Logos and names remain the property of their respective owners and are used for identification, without endorsement.

- The original OpenOrc icon, avatars, website artwork, Rive mascot, and rocket are distributed under the project's Apache-2.0 terms. [Artwork provenance](docs/artwork-provenance.md) identifies their sources and fingerprints the distributed assets.
- Provider names and marks, including OpenAI, Codex, Claude, Claude Code, OpenCode, and Slack, belong to their respective owners. OpenOrc uses them only to identify compatible tools and services, and is not affiliated with, sponsored by, or endorsed by those owners. The OpenAI, Claude, OpenCode, and Slack logos are not covered by OpenOrc's Apache-2.0 license or its original-artwork terms; their sources and local modifications are listed in [artwork provenance](docs/artwork-provenance.md#provider-marks).
- The OpenCode SVG was adapted from the official repository by removing its background, cropping, and recoloring its paths. Its upstream MIT copyright/license text accompanies both the desktop and website distribution. This does not grant trademark rights.
- The Slack SVG is unchanged from Slack's official media kit. Desktop and website copies of the other three provider SVGs match byte-for-byte.
