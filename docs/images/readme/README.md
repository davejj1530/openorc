# README screenshots

`workspace.png` was captured on November 8, 2026 and `discussion.png` on November 6, 2026, both from the production renderer. In `workspace.png` the sidebar has the OpenOrc wordmark, inbox and toggle beside the window buttons, a rail with New thread, the screens, Projects, and the weekly usage ring above Settings, one search, threads listed by day under Recent, Today and a folded Yesterday, and the Resolved drawer, parted from the work column by a hairline seam. The rest of the window shows a finished Codex conversation with its receipt open on the three steps it took, ending in the OpenOrc cube, the composer's model and default permission pills, and the Changes panel. The sample conversations name GPT-6-Astra and Opus 5.5 (1M context), and the interface font is Immaculate Gothic at one weight.

The [product fixture](../../../scripts/fixtures/website-product-ui.tsx) renders real application components and styles with synthetic projects, conversations, task comments, and changes. It does not connect to real accounts, providers, project files, or the desktop database.

| Image            | Fixture view       | Logical viewport | PNG pixels  |
| ---------------- | ------------------ | ---------------- | ----------- |
| `workspace.png`  | `?view=review`     | 1440 × 980       | 2880 × 1960 |
| `discussion.png` | `?view=discussion` | 780 × 920        | 1560 × 1840 |

## Capture again

From the repository root, using the project's Node version:

```sh
node scripts/website-product-fixture.cjs
python3 -m http.server 4382 --bind 127.0.0.1 --directory output/qa/website-product
```

Open each view at `http://127.0.0.1:4382/?view=<view>&theme=dark`. In `?view=review`, click the finished turn's receipt line to open its steps before capturing. Capture in Electron, not a headless browser: load each view in a hidden `BrowserWindow` of the desktop's own Electron at the logical viewport above and save `webContents.capturePage()` on a display with a scale factor of 2. The app draws its hairlines at 0.5px. Electron paints them one device pixel wide as the app does, while headless Chromium drops the sidebar seam and doubles the other hairlines. The fixture's `scale` parameter was left unset. Wait for fonts and diffs to finish painting before capturing the page. The sample threads are dated relative to the capture time, so capture during the day: after midnight, the Today group can come out empty.

Images are direct PNG page captures, without compositing or retouching. Window buttons in the full workspace views are supplied by the existing fixture; the task discussion is a production panel detail. Keep temporary builds, capture scripts, and profiles in ignored `output/` directories. Inspect captures for private data and clipping before replacing these curated images.

The original interface and demo content follow the project's Apache-2.0 terms. Provider marks retain their separate rights; screenshots do not imply provider endorsement. See [artwork provenance](../../artwork-provenance.md). Image fingerprints are recorded in the [artwork manifest](../../artwork-manifest.json).
