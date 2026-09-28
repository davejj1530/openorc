# OpenOrc website

Static Astro website for OpenOrc. The homepage uses OpenOrc's charcoal and teal theme with a restrained metallic gradient and product demos rebuilt in HTML and CSS from the desktop renderer's styles. Geist is self-hosted; the page ships no React runtime. Google Analytics loads from Google to measure website visits.

```sh
pnpm install
pnpm --filter @openorc/website dev
pnpm --filter @openorc/website typecheck
pnpm --filter @openorc/website test
pnpm --filter @openorc/website build
pnpm --filter @openorc/website preview
```

The development server defaults to `http://localhost:4321`. Production output is `apps/website/dist`, ready for a static host. The site URL is configured as `https://openorc.app`.

## Downloads

`/download/` lists the uploaded installers from published GitHub Releases. It prefers the newest stable release with installers, falling back to the newest public beta before a stable release exists. Drafts, unfinished uploads, missing platform assets and foreign URLs never become download links. Before publication, Download leads to a page explaining that installers are not available yet, with a link to GitHub Releases. The site must rebuild after a release is published; the release hook below handles this when configured.

All Download buttons open `/download/`, which highlights a matching installer when the browser reports its platform and architecture. Detection uses [User-Agent Client Hints](https://developer.chrome.com/docs/privacy-security/user-agent-client-hints) where available. It does not infer Intel hardware from a MacIntel user agent, which Apple Silicon Macs can also report. When Mac architecture is unavailable, visitors choose Apple Silicon or Intel and receive instructions for finding their chip. Mobile visitors, unsupported platforms and uncertain Windows architectures receive manual choices. With JavaScript disabled, all links and choices remain usable. Device information is neither stored nor sent by the download code.

Windows beta installers are labeled unsigned when their published filename carries that designation. Beta updates are installed manually. The client never requests GitHub's releases API; release metadata is embedded at build time using the same cached request as the changelog.

## Changelog

`/changelog/` is generated at build time from published GitHub Releases. It shows the first five bullets under a release body's `## Highlights` or `## What's new` heading, then links to the full release notes. Drafts never appear. Public beta releases carry a Beta label; the header and footer link to the changelog once a public release exists. Until a release is published, the page shows a launch message.

Builds use `GITHUB_TOKEN` when supplied to avoid GitHub's shared-IP anonymous rate limit. GitHub Actions passes its built-in read-only token to the build steps; no repository secret is needed. Other build hosts can provide a token with read access to the public repository's releases. The token is used only by the build process and is not included in the static site. Without it, builds use the anonymous API and may hit its rate limit. Unexpected API errors still fail the build.

The development server does not request GitHub releases. It uses the empty changelog state and hides the changelog navigation links, so ordinary page loads and hot reloads work without GitHub access. Run a production build and preview it to check the published release notes. Visitors to the built static site never make a GitHub releases API request.

For each release, edit the GitHub draft's Highlights section with user-facing changes before publication. The release workflow creates that section along with installation notes.

When setting up Vercel, import this repository with `apps/website` as the Root Directory. Enable **Include source files outside of the Root Directory**, since the website build checks the root `scripts/` directory. Create a Deploy Hook for the production branch in **Project Settings → Git → Deploy Hooks** and save the URL as the repository secret `VERCEL_WEBSITE_DEPLOY_HOOK`. `.github/workflows/website-changelog.yml` calls the hook when a release is published, edited, or unpublished, so Vercel rebuilds the static page. It can also be run manually from Actions. Vercel's Git integration handles ordinary source changes. Keep the Deploy Hook URL secret.

## Product demonstrations

The homepage's Across threads, Task discussion, and Agent team previews are HTML and CSS scenes. Each scene is an OpenOrc window rebuilt from the desktop renderer's tokens, icons, and component geometry (`src/components/hero/`), driven by a **synthetic journey** in `src/data/hero/`: named moments in seconds, and elements that appear during windows written against them. `src/scripts/hero-scene.ts` plays a journey with human-paced typing and streamed replies, loops it, and pauses it offscreen; reduced-motion visitors and visitors without JavaScript see the final moment. Text stays live text, so the scene is sharp at every size. Under 1100px the window shows one view at a time, as the app does when it is narrow.

The scenes illustrate real flows with sample data; they do not run agents, change files, or contact providers. Cross-thread messages appear as the app's message notice card in the receiving thread, task comments address models with the app's `@Model - Effort` mentions, and agent team execution is labelled as an experimental preview on the page. Keep the copy in `src/data/hero/` aligned with the product when its labels or behaviour change.

The workflow section plays a fourth, longer scene (`data/hero/workflow.ts`): a question about app performance becomes three tasks, two models weigh in inside the first task, one builds it, and the change lands in a new thread. "Plan, Review, Ship" composes two HTML stills (`src/components/mocks/`): the Tasks view and the Changes panel. Stills share the scenes' tokens and scale with their frame, so they stay sharp at every density. The site uses no screenshots. The synthetic renderer fixture in `scripts/fixtures/website-product-ui.tsx` renders the [README screenshots](../../docs/images/readme/README.md) through `node scripts/website-product-fixture.cjs`.

## Content boundaries

Slack copy follows [the integration documentation](../../docs/slack.md): agent work runs on the user's computer, so OpenOrc must stay open and the computer awake for scheduled work and Slack replies. Provider subscriptions and API usage remain separate. Local data claims distinguish stored workspace data from requests sent to the chosen provider. Download links come from published release assets, rather than guessed filenames or unreleased tags.

## Asset provenance

- `public/hero-orchestra-linework-subtle*.{avif,webp}` and `public/closing-orchestra-linework-subtle*.{avif,webp}`: desktop and mobile copies of the generated hero and closing illustrations. Their full-size sources are in `assets/website/`, outside the website; see [artwork provenance](../../docs/artwork-provenance.md).
- `src/assets/openorc-mark.png`: byte-identical copy of `apps/desktop/src/renderer/src/assets/openorc-mark.png`, the generated transparent metallic OpenOrc mark.
- `src/assets/team-avatars/*`: unchanged copies of the first four default team portraits from `apps/desktop/src/renderer/src/assets/team-avatars/` (Hollow, Ripple, Helix, Portal), used by the Agent team scene. Their mapping and processing are documented there.
- `public/favicon-64.png`: 64px derivative of `apps/desktop/resources/icon.png` for the browser tab. Source and build instructions are in `apps/desktop/resources/README.md`.
- `public/slack.svg`: unchanged full-color Slack mark from Slack's [official media kit](https://slack.com/media-kit), sourced from `https://a.slack-edge.com/9cc0056/marketing/img/nav/logo.svg`. The homepage shows it beside the Slack heading, slightly muted with CSS `saturate(0.75)`; trademark rights remain separate.
- Provider SVGs: copied from the desktop app's provider assets. OpenCode's adapted mark removes the background, crops the viewBox, and recolors its paths; its original MIT text is preserved at `public/licenses/opencode-MIT.txt`. The homepage recolors the marks for its dark theme: `AgentLogos.astro` fills all three with the text color, `ProductPreview.astro` draws the OpenAI mark in white and lightens OpenCode's grays, and the provider list applies the CSS filters in `global.css` and `home.css`. Provider marks retain separate rights; see [artwork provenance](../../docs/artwork-provenance.md#provider-marks).
- Geist: `@fontsource-variable/geist@5.3.0`, under SIL OFL 1.1. Its original copyright and license text are copied to `public/licenses/geist-OFL-1.1.txt` and shipped at `/licenses/geist-OFL-1.1.txt`.

The build verifies reviewed dependency versions and notice hashes before Astro runs. After building, run `node scripts/distribution-notices.cjs website /absolute/path/to/apps/website/dist` to check both notice copies in the output. See [the distribution audit](../../docs/distribution-notices.md).

## Other pages

`/docs/` documents how the app works internally, in fourteen pages listed in `src/data/docs.ts` and built with `src/layouts/DocsLayout.astro`. Every claim is checked against the source; each page names the files it describes, and `docsReviewed` in `src/data/docs.ts` records the date the pages were last checked against the source. Update a page in the same change that alters the behavior it describes. `/architecture/` redirects to `/docs/`. `/privacy/` describes the website and desktop app's data handling and is linked from the footer.
