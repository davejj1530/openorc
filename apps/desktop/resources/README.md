# OpenOrc app icon

`icon.svg` is the editable source: the same cube and cut-out top face used by `OpenOrcMark.tsx` and the website's `BrandMark.astro`, in off-white on a charcoal tile. Original OpenOrc artwork is covered by the project's Apache-2.0 terms; provider marks retain separate rights. `icon.png` is its generated 1024px RGBA representation, with transparent padding outside the tile.

The main process uses this PNG for window icons and the macOS Dock, including development launches. Packaging includes it inside the app archive. macOS uses `../build/icon.icns` for the application bundle; Windows uses the PNG source through electron-builder. Linux installers take their icon sizes from the ICNS, because icon themes list sizes only up to 512px.

After editing the SVG, run `pnpm --filter @openorc/desktop icons:build` from a full workspace install. The script uses the website's Sharp dependency to regenerate the PNG, the desktop renderer's `src/assets/favicon.svg`, and the website's `public/favicon.svg` and `public/favicon-64.png`. Favicons crop away the outer Dock padding so the cube stays readable in a browser tab. On macOS, the script also regenerates the ICNS with all ten standard 1x/2x representations using `iconutil`; other platforms leave the existing ICNS alone.

Restart the app to update its running Dock icon; rebuild the package to update Finder's app icon. Preserve transparency outside the tile, verify readability at small sizes, and refresh the affected fingerprints in `docs/artwork-manifest.json` after regeneration.

The website uses a visual copy of this master. [Artwork provenance](../../../docs/artwork-provenance.md) and the accompanying manifest record the source files and their hashes.
