# README screenshots

`workspace.png` was captured on November 26, 2026, and `discussion.png` on November 25, 2026. In `workspace.png` the sidebar has its toggle with Back and Forward beside the window buttons; New thread and the screens as rows, Tasks with its amber count; the list's name, My workspaces, with search, Add project and the filter; the threads under their projects' open cubes, one line each, the working one led by its cube of dots, yesterday's under their label, and each project's own Resolved; and Settings at its foot, parted from the work column by a seam from the window's top to its foot. The work column's header has two thread tabs carrying the marks of the agents they run on, Claude and Codex, New thread and the Orcling's face. The rest of the window shows a finished Codex conversation with its receipt open on the work it did, a step a line with what each step read, edited and ran, and Timeline under them; the reply with the proof pill beside its claim, the change card, "Worked for 1m 12s" with Copy and Fork, the OpenOrc cube, and the composer with the week's usage in its model pill, the permission pill, the context share, Dictate and send. The Changes panel stands beside it at 460 wide with Files and Terminal tabs. The sample conversations name GPT-6-Astra and Opus 5.5 (1M context), and the interface font is the Mac's own, the app's default on a Mac.

The [product fixture](../../../scripts/fixtures/website-product-ui.tsx) renders real application components and styles with synthetic projects, conversations, task comments, and changes. It does not connect to real accounts, providers, project files, or the desktop database.

| Image            | Fixture view                                            | Logical viewport | PNG pixels  |
| ---------------- | ------------------------------------------------------- | ---------------- | ----------- |
| `workspace.png`  | `?view=review&tabs=welcome&panel=file,terminal,changes` | 1512 × 1120      | 3024 × 2240 |
| `discussion.png` | `?view=discussion`                                      | 900 × 950        | 1800 × 1900 |

## Capture again

From the repository root, using the project's Node version:

```sh
node scripts/website-product-fixture.cjs
python3 -m http.server 4382 --bind 127.0.0.1 --directory output/qa/website-product
```

Both images were captured from the same fixture served by Vite in development mode, on its own port and cache directory, because the production fixture build stops at load ("is not a constructor").

Open each view at `http://127.0.0.1:4382/?view=<view>&theme=dark`. In `?view=review`, set the panel to 460 wide (`useLayout.getState().setPanelWidth(460)`; its 640 default leaves the conversation narrow) and click the finished turn's receipt line to open its work before capturing. The window is tall enough to show the whole turn with its work open. Capture in Electron, not a headless browser: load each view in a hidden `BrowserWindow` of the desktop's own Electron, with a fresh user data directory each time, at the logical viewport above and save `webContents.capturePage()` on a display with a scale factor of 2. A reused profile brings back the tabs and panel pages an earlier capture left open. The app draws its hairlines at 0.5px. Electron paints them one device pixel wide as the app does, while headless Chromium drops the sidebar seam and doubles the other hairlines. The fixture's `scale` parameter was left unset. Wait for fonts and diffs to finish painting before capturing the page.

Images are direct PNG page captures, without compositing or retouching. Window buttons in the full workspace views are supplied by the existing fixture; the task discussion is a production panel detail. Keep temporary builds, capture scripts, and profiles in ignored `output/` directories. Inspect captures for private data and clipping before replacing these curated images.

The original interface and demo content follow the project's Apache-2.0 terms. Provider marks retain their separate rights; screenshots do not imply provider endorsement. See [artwork provenance](../../artwork-provenance.md). Image fingerprints are recorded in the [artwork manifest](../../artwork-manifest.json).
