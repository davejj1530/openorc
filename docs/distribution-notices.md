# Distribution notice checks

Original OpenOrc work uses Apache-2.0. Third-party dependencies and assets retain their respective terms. The source manifest and artifact checks preserve reviewed notices and identify gaps; they do not establish complete redistribution clearance.

## Maintained inputs

[The manifest](../licenses/manifest.json) records reviewed package versions, exact source locations, hashes, and distribution destinations. Supplemental notices and provenance evidence are retained under `licenses/vendor/`.

The updater dependency `electron-updater` 6.8.9 ships an MIT text that is preserved and hash-checked. Its `lazy-val` 1.0.5 dependency has a metadata MIT declaration naming Vladimir Krivosheev as author; the package and npm source commit lack copyright/license text. That metadata is preserved without inventing a notice. The manifest records a notice exception for this exact version: the audit reports the omission without failing solely on it, checks the preserved metadata bytes, and compares the packaged name, version, license and author. Upgrades, changed declarations, missing evidence and unrelated notice gaps still fail. This documents the decision to retain the dependency; it does not establish complete licensing clearance.

Electron's original LICENSE and Chromium notice collection are copied from the downloaded runtime into the app's `licenses/electron/` directory. Supplemental files retain notices that packaging can strip with package READMEs, including fastdom, strictdom and lru_map. Parent packages retain their own notices separately from those of nested dependencies.

The website publishes byte-identical Geist OFL and OpenCode MIT texts under `/licenses/`. Build-time dependencies are not automatically distributed dependencies; review generated HTML, CSS, images, fonts, scripts and any new bundles when the website changes.

MiniLM uses the JavaScript Tokenizers.js package. The native `@anush008/tokenizers` package is no longer installed, but its MIT text and native notice collection still ship in the desktop app's `licenses/` folder. The manifest keeps a limitation rule for it, so the artifact audit exits 2 if a native tokenizer package is reintroduced. See [tokenizer compatibility](tokenizer-replacement.md) and [native notice sources](native-notice-evidence.md).

## Evidence and boundaries

Exact pinned URLs and hashes are in the manifest. The following describes what those records establish.

| Material                                         | Preserved evidence                                                                                                                                         | Limits                                                                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron 44.3.0                                  | Original downloaded MIT license and `LICENSES.chromium.html`; packaged framework version matches the reviewed runtime                                      | This preserves the supplied notice collection; it is not an independent audit of every Chromium component                                                                    |
| node-pty 1.1.0                                   | Package LICENSE and nested winpty LICENSE retained in the archive                                                                                          | Windows packages must be audited on Windows; the release workflow audits the installed Windows app                                                                           |
| sqlite-vec 0.1.9                                 | MIT and Apache texts from release commit `e9f598abfa0c06b328d8fe5da9c3760cce74be10`                                                                        | Covers the reviewed wrapper/platform package version; preserve any additional notices when rebuilding native dependencies                                                    |
| ONNX Runtime 1.21.0                              | MIT and upstream `ThirdPartyNotices.txt` from release commit `e0b66cad282043d4377cea5269083f17771b6dfc`                                                    | The aggregate includes optional providers. Its presence does not attest which components are linked into the shipped binaries                                                |
| Rive canvas 2.42.1                               | WASM wrapper MIT at npm gitHead `e0bfcec3ccd0f1dee01686776da68f439a95cbfa`; runtime MIT at its submodule commit `45d4d01dfd1fe70d3f9e73764538c16f63a04d07` | The source build configuration identifies the third-party components below; exact compiled composition is not independently attested                                         |
| Rive native dependencies                         | Pinned HarfBuzz, SheenBidi, Yoga, miniaudio, Luau, and Lua notice files                                                                                    | Supplemental Skia, file-specific headers, libhydrogen, Microsoft/Unicode and Emscripten notices are also preserved; compiled composition remains independently unverified    |
| remark-math 6.0.0 / rehype-katex 7.0.1           | Monorepo MIT license at each package's npm gitHead                                                                                                         | Kept separately from their nested dependencies' notices                                                                                                                      |
| react-remove-scroll-bar 2.3.8                    | Official upstream MIT text pinned at `8ca9ba5ea52de03308fe8ced94f7b159a44d28ff`                                                                            | The published gitHead `b3b1287aad81def2e2ae707274b74531b61ddbaf` is not available upstream, so this is license evidence, not a copy from the exact published source          |
| fastdom 1.0.12 / strictdom 1.0.1 / lru_map 0.4.1 | Complete MIT sections copied unchanged from the installed package READMEs                                                                                  | Separate copies are necessary because the packager strips those READMEs                                                                                                      |
| FastEmbed 2.1.0                                  | Original MIT file retained and hash-checked                                                                                                                | The local tar patch and Blue Oak notice obligations are recorded in [dependency remediation](dependency-remediation.md) and [third-party notices](../THIRD_PARTY_NOTICES.md) |
| Inter, JetBrains Mono, Geist 5.3.0               | Original OFL texts in the appropriate desktop/website artifact                                                                                             | Font rights remain separate from the project's Apache license                                                                                                                |
| OpenCode mark                                    | Official repository MIT text at `fe3f3a41f79ad292cc3c7c629567385a20ec5130`, accompanying desktop and website copies                                        | The SVG is cropped and recolored. Copyright evidence does not resolve trademark use; see [artwork provenance](artwork-provenance.md)                                         |

The Rive component pins come from that runtime's build configuration, including the default text, layout, audio, and scripting dependencies. Their exact revisions are recorded beside each notice. HarfBuzz's COPYING itself directs readers to additional directory/file notices; this inventory does not replace that source-level review.

## Artifact scope

- Rive source/build pins, borrowed headers and toolchain limits are recorded in [native evidence](native-notice-evidence.md). These source-derived notice collections do not independently attest the exact compiled composition.
- Inspect every shipping platform and installer. The desktop artifact reader supports macOS `.app` bundles and Windows application directories; Windows directories must be inspected on Windows. Linux packages are not supported. Model weights are downloaded on first use; their converted archive provenance and notices need a separate review before bundling or mirroring them.
- Provider marks retain separate rights. [Artwork provenance](artwork-provenance.md#provider-marks) records sources, modifications, permission limits and outstanding presentation checks.

## Repeating the checks

After a frozen install, run from the repository root:

```sh
pnpm licenses:check
node --test scripts/distribution-notices.test.cjs
pnpm --filter @openorc/desktop build
pnpm --filter @openorc/desktop exec electron-builder --dir --config.directories.output=/absolute/disposable-output
node scripts/distribution-notices.cjs desktop /absolute/disposable-output/mac-arm64/OpenOrc.app /absolute/desktop-notices.json
# On Windows, pass the application directory instead, such as /absolute/disposable-output/win-unpacked.
pnpm --filter @openorc/website build
node scripts/distribution-notices.cjs website /absolute/repository/apps/website/dist /absolute/website-notices.json
```

`licenses:check` verifies only the manifest-listed package versions, notice hashes, and website public copies. Electron-builder's `beforePack` hook runs the desktop scope; the website build runs its own scope. A new dependency outside the manifest is not automatically blocked by these hooks. Run the **separate desktop artifact audit** to find additional package-level notice gaps, including nested dependencies, after packaging.

The artifact audit compares reviewed notice bytes, package versions, the Electron framework version, and root LICENSE/NOTICE/THIRD_PARTY_NOTICES copies. Other package licenses are inventoried by file presence; their contents are not all individually validated. Exit **0** means the scoped checks passed, possibly with explicitly reported notice exceptions; **1** means a failed check; **2** means reviewed bytes passed but the artifact contains missing package notices without an exception or recorded package limitations. Exceptions remain visible in console output and the JSON report. If a native tokenizer binary is present, neither its MIT notice nor a metadata exception clears its limitation. No exit status establishes complete legal clearance.

When upgrading a reviewed dependency, inspect its upstream notices, preserve the original bytes, refresh the manifest version/source/hash, update any website copy, and inspect a new artifact. Never update hashes merely to silence a failure. Upstream text is excluded from formatting. See [the notice directory](../licenses/README.md).
