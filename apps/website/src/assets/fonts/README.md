# Immaculate Gothic

Unmodified WOFF2 files from David's `Immaculate-Gothic-Family-1.101` package, supplied for the OpenOrc website and desktop app. Both binaries are version 1.000. They provide the upright Text face at 450 and Bold at 700; there is no variable or italic face. The desktop copies in `apps/desktop/src/renderer/src/assets/fonts/` are byte-identical to these files.

| File                          | SHA-256                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `ImmaculateGothic-Text.woff2` | `805ffefb76b76b7a50b876389a3118bbd55a4b80791e5d6abbca721b9aa071f2` |
| `ImmaculateGothic-Bold.woff2` | `727eb68d0eea9d760cb91f8d6c9ae3d34d515710d50d45e361f1aa2979b0ee8a` |

The supplied [provenance](../../../../../licenses/vendor/immaculate-gothic-PROVENANCE.txt) is retained byte for byte, published at `/licenses/immaculate-gothic-PROVENANCE.txt`, and included in the desktop app's `licenses/vendor/` resources. It records custom authorship without assigning an open-source license; the font is separate from the repository's Apache-2.0 code license.

`global.css` registers the two faces with `font-display: swap`, normal kerning, and no synthetic weights or italics. `Layout.astro` preloads Text; Bold loads where used. Astro emits both files with content hashes. System fallbacks cover characters outside the supplied Latin faces. Product demos use Immaculate Gothic to match the app's default font, with JetBrains Mono for code.

The desktop app's `fonts.css` registers the same faces. Its interface font defaults to Immaculate Gothic and can be changed in Appearance; a separate Code font setting selects JetBrains Mono, Geist Mono, or the system monospace face.
