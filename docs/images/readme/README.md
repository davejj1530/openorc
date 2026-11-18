# README screenshots

`workspace.png` and `discussion.png` were captured on November 19, 2026. In `workspace.png` the sidebar has the OpenOrc wordmark with Back and Forward beside the window buttons; New thread and the screens as rows, Tasks with its amber count; Workspaces with search, Add project and the filter; the threads under their projects, one line each, the working one with its cube; Resolved; and the weekly usage and Settings at its foot, parted from the work column by a hairline from the window's top to its foot. The work column's header has the sidebar toggle, two thread tabs carrying the marks of the agents they run on, Claude and Codex, New thread and the Orcling's face. The rest of the window shows a finished Codex conversation with its receipt open on the three steps it took, the change card, "Worked for 1m 12s" with Copy and Fork, the OpenOrc cube, the composer's model and default permission pills, and the Changes panel. The sample conversations name GPT-6-Astra and Opus 5.5 (1M context), and the interface font is Immaculate Gothic at one weight.

The [product fixture](../../../scripts/fixtures/website-product-ui.tsx) renders real application components and styles with synthetic projects, conversations, task comments, and changes. It does not connect to real accounts, providers, project files, or the desktop database.

| Image            | Fixture view                                            | Logical viewport | PNG pixels  |
| ---------------- | ------------------------------------------------------- | ---------------- | ----------- |
| `workspace.png`  | `?view=review&tabs=welcome&panel=file,terminal,changes` | 1440 × 980       | 2880 × 1960 |
| `discussion.png` | `?view=discussion`                                      | 780 × 920        | 1560 × 1840 |

## Capture again

From the repository root, using the project's Node version:

```sh
node scripts/website-product-fixture.cjs
python3 -m http.server 4382 --bind 127.0.0.1 --directory output/qa/website-product
```

Both images of November 19 were captured from the same fixture served by Vite in development mode, on its own port and cache directory, because the production fixture build stopped at load that day ("is not a constructor").

Open each view at `http://127.0.0.1:4382/?view=<view>&theme=dark`. In `?view=review`, click the finished turn's receipt line to open its steps before capturing. Capture in Electron, not a headless browser: load each view in a hidden `BrowserWindow` of the desktop's own Electron, with a fresh user data directory each time, at the logical viewport above and save `webContents.capturePage()` on a display with a scale factor of 2. A reused profile brings back the tabs and panel pages an earlier capture left open. The app draws its hairlines at 0.5px. Electron paints them one device pixel wide as the app does, while headless Chromium drops the sidebar seam and doubles the other hairlines. The fixture's `scale` parameter was left unset. Wait for fonts and diffs to finish painting before capturing the page.

Images are direct PNG page captures, without compositing or retouching. Window buttons in the full workspace views are supplied by the existing fixture; the task discussion is a production panel detail. Keep temporary builds, capture scripts, and profiles in ignored `output/` directories. Inspect captures for private data and clipping before replacing these curated images.

The original interface and demo content follow the project's Apache-2.0 terms. Provider marks retain their separate rights; screenshots do not imply provider endorsement. See [artwork provenance](../../artwork-provenance.md). Image fingerprints are recorded in the [artwork manifest](../../artwork-manifest.json).
