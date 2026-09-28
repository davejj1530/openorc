# OpenOrc mascot

The new-thread screen uses the soft-square Rive character with large upright eyes.

## Artwork

- `questling.riv`: bundled runtime asset, including four looping animations and data bindings.
- The editable Rive source document is not published in this repository.
- `apps/desktop/src/renderer/src/components/MascotStill.tsx`: matching rest pose for loading, errors, reduced motion, and the theme editor preview.

The `App states` machine uses the numeric `expression` property: 0 Idle, 1 Thinking, 2 Working, 3 Happy. Any expression can transition directly to another in 180ms. The file also contains the `Questling states` click-cycle machine for standalone previews.

`bodyColor` controls the body, activity dots, and sparkles. `eyeColor` controls both normal and happy eyes. Update the corresponding Rive view-model colors at runtime; no re-export is needed for color changes.

## App integration

`NewThreadMascot` renders in an 80 × 56px frame with a 104px canvas. Compact windows use a 62 × 43px frame with an 80px canvas. Rendering uses at most 2× device pixel ratio. WebGPU is not required.

`mascot-runtime.ts` and the locally bundled Rive WASM load only when motion is allowed. Hidden and offscreen playback stops. Unmount releases the runtime, observers, theme subscription, and reaction timer. Failed loading leaves the vector still visible.

Effort changes play Thinking; Fast On plays Happy; Fast Off plays Working. Reactions interrupt each other and return to Idle. Initial model loading and hidden interactions do not trigger reactions.

Settings → Appearance → Colors → Mascot edits `--mascot-body` and `--mascot-eyes`, separately for each palette and light/dark mode. The live canvas and vector fallback use the same tokens. Defaults use the palette foreground and background, independently of the action accent.

## Verification

```sh
pnpm --filter @openorc/desktop exec vitest run src/renderer/src/components/mascot-runtime.test.ts src/renderer/src/lib/theme-custom.test.ts
```
