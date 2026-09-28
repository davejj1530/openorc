# Precision Outline icons

OpenOrc uses its own SVG icon family, generated with Codex. The geometry is original, with consistent stroke weight and optical size. See [interface conventions](design-system.md#icons-and-motion).

## Source and integration

- `apps/desktop/src/renderer/src/components/icons.tsx`: shared 24-unit geometry, 1.75-unit strokes, rounded caps and joins. Components accept SVG props and refs; controls retain their accessible labels. Icons use the caller's color and size.
- Application controls import the local family through the shared module.
- Framework/language project logos are an explicit exception, requested by the user: `ProjectStackIcon.tsx` displays 24 upstream Devicon SVGs, not original OpenOrc drawings. Their pinned source URLs and hashes live in `assets/project-stacks/manifest.json`; see [artwork provenance](artwork-provenance.md#project-framework-and-language-logos). `scripts/project-stack-size.cjs` measures this selected set without including a whole icon library.
- RichText supplies the complete Streamdown icon map. The diff viewer uses its `onPostRender` extension to install generated symbols in each shadow root. Native selects use the generated chevron asset. The composer's context ring remains a data visualization.
- Some export names are retained for call-site compatibility: `Brain` is the layered memory mark, `FolderGit2` is the project folder, and `Workflow` is the coordinated agent mark.

## Regenerate exports

Run from the repository root after editing icon geometry:

```sh
TSX_TSCONFIG_PATH=apps/desktop/tsconfig.web.json node --import tsx apps/desktop/scripts/icon-preview.mts
```

This writes individual SVGs and a light/dark size-comparison sheet into `output/icons/`, and refreshes the diff and select SVG assets beside the source components. Those two assets must be regenerated when their source icons change.

`output/` is ignored local output and is absent from a fresh checkout. Add `--preview-only` to the command to generate just the gallery and preview exports without rewriting the tracked production SVGs. The icon smoke below generates these previews automatically before launching its checks.

## Verification

Run desktop type checking, tests, and the production build before the smoke. The icon smoke runs the built Electron app using `scripts/qa-seed.ts`'s disposable ledger; it never starts an agent. Run it with `OPENORC_QA_FIXTURE` pointing to that seed's `fixture.json`:

```sh
OPENORC_QA_FIXTURE=/path/to/fixture.json node apps/desktop/node_modules/electron/cli.js scripts/icons-ui-smoke.cjs
```

The smoke checks the shell, task list, light/dark themes, narrow desktop layout, diff symbol resolution, and icon viewBox bounds. Screenshots and its report are written to the ignored local `output/icons/` directory.
