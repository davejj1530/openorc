# OpenOrc app icon

`icon.png` is the 1024px RGBA master, generated as original OpenOrc artwork. It depicts an original monochrome luminous shell on a charcoal tile. Original OpenOrc artwork is covered by the project's Apache-2.0 terms; provider marks retain separate rights.

The main process uses this PNG for window icons and the macOS Dock, including development launches. Packaging includes it inside the app archive. macOS uses `../build/icon.icns` for the application bundle; Windows and Linux use the PNG source through electron-builder.

After replacing the master, run `pnpm --filter @openorc/desktop icons:build` on macOS to regenerate the ICNS with all ten standard 1x/2x representations. Restart the app to update its running Dock icon; rebuild the package to update Finder's app icon. Preserve transparency outside the tile and verify readability at small sizes.

The website uses a visual copy of this master. [Artwork provenance](../../../docs/artwork-provenance.md) and the accompanying manifest record the source files and their hashes.
