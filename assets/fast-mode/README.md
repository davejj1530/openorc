# Fast Mode slider rocket

Original OpenOrc artwork created in Rive. The runtime export and matching SVG are included. The editable Rive document is not published in this repository.

- `fast-mode-rocket.riv`: runtime export. Select artboard `Slider Rocket`, state machine `FastMode`.
- `fast-mode-rocket.svg`: matching static artwork with a white capsule, lavender fins/nose/window rim, a dark plum window and warm exhaust.

The shared `ViewModel1` exposes `accentColor` for the fins, nose and window rim; the app supplies its dedicated lavender effect color. Each runtime uses its own view-model instance. The Rive `Flame` timeline loops over 60 frames at 60 fps and varies the exhaust length.

Five solid colors were edited directly in the runtime export, so its palette matches the SVG. The Electron rendering checks below cover the result.

## Behavior

The Fast toggle remains a lightning control. Enabling Fast mounts the illustrated rocket inside the effort slider, where it travels from the left edge to the knob in 900 ms. The rocket replaces the white knob, centered on the selected effort. CSS positions it relative to the slider geometry, with 32px end insets to keep the whole rocket visible. Its compact 64 × 32px canvas sits comfortably on the 28px track, with a matching 32px pointer target. It follows later pointer/keyboard effort changes. The native range handles pointer and keyboard input. Grabbing anywhere on the rocket preserves the grab offset; dragging takes over immediately if the launch is still running. Disabling Fast restores the white knob.

Disabling Fast removes the rocket. Reopening with Fast enabled repeats the launch. Reduced motion shows the static illustration at the destination immediately. The Rive flame pauses when hidden or offscreen. All runtime assets are local.

At the highest supported effort, lavender and purple nebula colors matching the effect palette roll on a 2.4-second cycle. Near stars stream left every 850ms; distant stars move every 2.2 seconds. All three layers pause while hidden or offscreen, and reduced motion shows a still galaxy. Lowering or resetting effort removes the galaxy and restores the regular fill.

## Verification

```sh
node apps/desktop/mascot-review.mjs
env -u ELECTRON_RUN_AS_NODE pnpm --filter @openorc/desktop exec electron ../../scripts/fast-mode-effects-smoke.cjs
```

The synthetic Electron fixture checks actual Rive rendering, travel from left to knob, following effort changes, Fast toggling, ten appearance combinations, keyboard controls, reset, provider-specific maximum effort, reduced motion and narrow layout. It does not start agent runs or access the application ledger. Screenshots and results are saved under `/tmp/openorc-fast-*`.
