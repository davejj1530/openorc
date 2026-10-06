# README screenshots

Captured on October 6, 2026 from the production renderer, with the current sidebar, the OpenOrc cube that ends a conversation, the composer's workspace footer, Immaculate Gothic type and team avatars. The sample conversations name GPT-6-Astra and Opus 5.5 (1M context).

The [product fixture](../../../scripts/fixtures/website-product-ui.tsx) renders real application components and styles with synthetic projects, conversations, task comments, and changes. It does not connect to real accounts, providers, project files, or the desktop database. The team view demonstrates team execution, now in Beta.

| Image            | Fixture view       | Logical viewport | PNG pixels  |
| ---------------- | ------------------ | ---------------- | ----------- |
| `workspace.png`  | `?view=review`     | 1440 × 980       | 2880 × 1960 |
| `teams.png`      | `?view=teams`      | 1440 × 980       | 2880 × 1960 |
| `discussion.png` | `?view=discussion` | 780 × 920        | 1560 × 1840 |

## Capture again

From the repository root, using the project's Node version:

```sh
node scripts/website-product-fixture.cjs
python3 -m http.server 4382 --bind 127.0.0.1 --directory output/qa/website-product
```

Open each view at `http://127.0.0.1:4382/`. These captures used Playwright's Chromium with a dark color scheme, the logical viewports above, and a device scale factor of 2. The fixture's `scale` parameter was left unset. Wait for fonts and diffs to finish painting before capturing the page. Check that the team conversation fits without scrolling; at a shorter viewport its first message loses its top spacing.

Images are direct PNG page captures, without compositing or retouching. Window buttons in the full workspace views are supplied by the existing fixture; the task discussion is a production panel detail. Keep temporary builds, capture scripts, and profiles in ignored `output/` directories. Inspect captures for private data and clipping before replacing these curated images.

The original interface and demo content follow the project's Apache-2.0 terms. Provider marks retain their separate rights; screenshots do not imply provider endorsement. See [artwork provenance](../../artwork-provenance.md). Image fingerprints are recorded in the [artwork manifest](../../artwork-manifest.json).
