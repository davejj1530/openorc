# Native notice evidence

This page records the upstream sources of the extra native notices in `licenses/`, for `@rive-app/canvas@2.42.1` and `@anush008/tokenizers-darwin-universal@0.0.0`. It supports the [distribution notice checks](distribution-notices.md). It is not a full inventory of the code compiled into those binaries.

Rive is a current dependency. The native tokenizer is not: [the MiniLM replacement](tokenizer-replacement.md) uses a JavaScript tokenizer instead. The tokenizer notices described below still ship in the desktop app's `licenses/` folder.

## Source and build scope

The reviewed wrapper revision is [`e0bfcec3`](https://github.com/rive-app/rive-wasm/tree/e0bfcec3ccd0f1dee01686776da68f439a95cbfa), with runtime submodule [`45d4d01d`](https://github.com/rive-app/rive-runtime/tree/45d4d01dfd1fe70d3f9e73764538c16f63a04d07). Its [canvas build](https://github.com/rive-app/rive-wasm/blob/e0bfcec3ccd0f1dee01686776da68f439a95cbfa/wasm/build_all_wasm.sh) copies both the ordinary and fallback WASM builds into the canvas package. The [build flags](https://github.com/rive-app/rive-wasm/blob/e0bfcec3ccd0f1dee01686776da68f439a95cbfa/wasm/build_wasm.sh) enable text, audio, layout, and scripting by default; the separate lite build disables these options.

Existing notices preserve Rive, HarfBuzz, SheenBidi, Yoga, miniaudio, Luau, and Lua. The following additions have specific source evidence.

## Additional source notices

- **Skia:** the [wrapper build](https://github.com/rive-app/rive-wasm/blob/e0bfcec3ccd0f1dee01686776da68f439a95cbfa/wasm/premake5.lua) unconditionally includes the copied `skia_imports` C++ files. All 24 [copied source/header files](https://github.com/rive-app/rive-wasm/tree/e0bfcec3ccd0f1dee01686776da68f439a95cbfa/wasm/src/skia_imports) identify a BSD-style license, with Google and Android Open Source Project copyright notices. Preserve those original header notices and the upstream [Skia BSD license](https://github.com/google/skia/blob/750673c775648c29002389a3f56fba459288eea9/LICENSE). Eighteen of the 24 copied files match that Skia `chrome/m99` revision after removing whitespace; four differ and two are absent from that revision. This supports the license text without claiming an exact Skia revision for every copied file. It does not imply that the full Skia renderer ships in canvas.
- **libhydrogen:** the runtime [scripting dependency declaration](https://github.com/rive-app/rive-runtime/blob/45d4d01dfd1fe70d3f9e73764538c16f63a04d07/scripting/premake5.lua) selects `luigi-rosso/libhydrogen` at `rive_0_2`, which resolves to `4c298c5e3012d891b8b375c6dd215f580a36ed60`. The [runtime build](https://github.com/rive-app/rive-runtime/blob/45d4d01dfd1fe70d3f9e73764538c16f63a04d07/premake5_v2.lua) compiles `libhydrogen.c` when scripting is enabled. Preserve that revision's [ISC license](https://github.com/luigi-rosso/libhydrogen/blob/4c298c5e3012d891b8b375c6dd215f580a36ed60/LICENSE), including Frank Denis's copyright notice.
- **Microsoft USE data:** Rive's [HarfBuzz build list](https://github.com/rive-app/rive-runtime/blob/45d4d01dfd1fe70d3f9e73764538c16f63a04d07/dependencies/premake5_harfbuzz_v2.lua) includes the generated USE table. That table's [generation header](https://github.com/rive-app/harfbuzz/blob/08d34675f64b1ac4880f4f10c9fd474a56dd4399/src/hb-ot-shaper-use-table.hh) identifies the additional Microsoft data files as inputs. Preserve their separate [Microsoft MIT notice](https://github.com/rive-app/harfbuzz/blob/08d34675f64b1ac4880f4f10c9fd474a56dd4399/src/ms-use/COPYING); HarfBuzz's root COPYING does not contain it.
- **Unicode data:** HarfBuzz's [UCD table](https://github.com/rive-app/harfbuzz/blob/08d34675f64b1ac4880f4f10c9fd474a56dd4399/src/hb-ucd-table.hh) identifies Unicode 17.0.0; its [emoji table](https://github.com/rive-app/harfbuzz/blob/08d34675f64b1ac4880f4f10c9fd474a56dd4399/src/hb-unicode-emoji-table.hh) includes the 2025 Unicode copyright notice and licensing link. Preserve that attribution with the official [Unicode License V3](https://www.unicode.org/license.txt). The preserved license text has the copyright range 1991–2026. That URL is not versioned, so keep the preserved bytes and hash rather than treating the URL as a fixed Unicode 17 license.

## Emscripten runtime notices

The pinned wrapper's [SDK setup](https://github.com/rive-app/rive-wasm/blob/e0bfcec3ccd0f1dee01686776da68f439a95cbfa/wasm/get_emcc.sh) defaults to Emscripten **4.0.23**, with an environment override. The official tag resolves to [`7a5d93b5`](https://github.com/emscripten-core/emscripten/tree/7a5d93b50f6a3a35e85a0d2fc9e667b8498e6aed). Preserve these upstream notice collections for the generated glue and C/C++ runtime contributions:

| Collection                                      | Exact upstream source                                                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Emscripten, including its Node-derived portions | [LICENSE](https://github.com/emscripten-core/emscripten/blob/7a5d93b50f6a3a35e85a0d2fc9e667b8498e6aed/LICENSE)                                |
| musl                                            | [COPYRIGHT](https://github.com/emscripten-core/emscripten/blob/7a5d93b50f6a3a35e85a0d2fc9e667b8498e6aed/system/lib/libc/musl/COPYRIGHT)       |
| libc++                                          | [LICENSE.TXT](https://github.com/emscripten-core/emscripten/blob/7a5d93b50f6a3a35e85a0d2fc9e667b8498e6aed/system/lib/libcxx/LICENSE.TXT)      |
| libc++abi                                       | [LICENSE.TXT](https://github.com/emscripten-core/emscripten/blob/7a5d93b50f6a3a35e85a0d2fc9e667b8498e6aed/system/lib/libcxxabi/LICENSE.TXT)   |
| compiler-rt                                     | [LICENSE.TXT](https://github.com/emscripten-core/emscripten/blob/7a5d93b50f6a3a35e85a0d2fc9e667b8498e6aed/system/lib/compiler-rt/LICENSE.TXT) |

These LLVM texts include their exceptions for embedded compiled portions; preserving them does not assert every listed notice is independently mandatory for this artifact. The musl notice identifies additional file-level terms, so it should not be described as a complete per-function inventory. Build tools such as Premake or Closure are not automatically shipped dependencies simply because the build invokes them.

Neither installed canvas WASM file contains a custom `producers` section, and the WASM was not rebuilt. So 4.0.23 is the source build default, not a confirmed toolchain for the published binary. The source-identified notices are preserved regardless.

## Integration and verification

The Rive texts are preserved in [licenses/vendor](../licenses/vendor/). Nine files match upstream notice bytes; two preserve source copyright headers. [Header sources](../licenses/rive-header-sources.json) record exact URLs, source hashes, and extraction byte ranges. The [manifest](../licenses/manifest.json) guards their hashes and packaged destinations, including Unicode's original source-data attribution alongside its license.

## Tokenizer notices

These files cover the native `@anush008/tokenizers` package that OpenOrc no longer installs. They still ship in the desktop app.

The crate list comes from Rust source paths embedded in the Darwin universal binary from the [published npm tarball](https://registry.npmjs.org/@anush008/tokenizers-darwin-universal/-/tokenizers-darwin-universal-0.0.0.tgz) (binary SHA-256 `f3cec59029a641b7b842908836bfa4ce883ccbb1815804fd3470873f094790f6`). Those paths identify **34 crate versions**, including Hugging Face `tokenizers-0.14.0`, `napi-2.13.3`, and `onig-6.4.0`. The [source inventory](../licenses/tokenizer-notice-sources.json) lists each published crate archive's URL and hash and each preserved notice's hash. It records observed versions, not a complete dependency graph or proof that all features in each crate are linked.

The [native notice collection](../licenses/vendor/tokenizer-native-NOTICES.txt) preserves **68 sections** from these sources, including Unicode table terms, Crossbeam's third-party text, and the original sais-lite copyright header in `esaxx-rs`. The napi crate omits its license file; its `.cargo_vcs_info.json` identifies source revision `b1dd6132438badade7947a95d8d12e3c053a374a`, whose [root MIT license](https://github.com/napi-rs/napi-rs/blob/b1dd6132438badade7947a95d8d12e3c053a374a/LICENSE) is preserved instead. Upstream bytes remain unchanged inside each labeled section.

Embedded paths cannot identify every linked crate, bundled C library, or Rust standard-library contribution, so this collection is incomplete. Linux and Windows binaries were not inventoried. The manifest keeps a limitation rule, so the artifact audit exits 2 if a native tokenizer package is reintroduced.
