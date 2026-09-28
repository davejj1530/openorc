import rocketUrl from "../../../../../../assets/fast-mode/fast-mode-rocket.riv?url&no-inline";
import { Alignment, Fit, Layout, Rive } from "./bundled-rive";
import type { CanvasAnimation, CanvasAnimationInput } from "./canvas-animation";

export function createRocketAnimation({ canvas, onReady, onError }: CanvasAnimationInput): CanvasAnimation {
  let loaded = false;
  let playing = false;
  let revealed = false;
  // Canvas resolves every palette's CSS color syntax (including LCH) to sRGB.
  const swatch = document.createElement("canvas");
  swatch.width = swatch.height = 1;
  const context = swatch.getContext("2d", { willReadFrequently: true });
  const syncColors = () => {
    if (!loaded || !context) return;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = getComputedStyle(canvas).color;
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
    animation.viewModelInstance?.color("accentColor")?.rgb(r, g, b);
  };
  const syncPlayback = () => {
    if (!loaded) return;
    if (playing) animation.play("FastMode");
    else animation.pause("FastMode");
  };
  const animation = new Rive({
    canvas,
    src: rocketUrl,
    artboard: "Slider Rocket",
    stateMachines: "FastMode",
    autoBind: true,
    autoplay: false,
    enableRiveAssetCDN: false,
    shouldDisableRiveListeners: true,
    layout: new Layout({ fit: Fit.Contain, alignment: Alignment.Center }),
    onLoad: () => {
      if (!context || !animation.viewModelInstance?.color("accentColor")) {
        onError();
        return;
      }
      loaded = true;
      syncColors();
      animation.resizeDrawingSurfaceToCanvas();
      syncPlayback();
    },
    onLoadError: onError,
    onAdvance: () => {
      if (loaded && !revealed) {
        revealed = true;
        onReady();
      }
    },
  });
  return {
    syncColors,
    resize: () => {
      if (loaded) animation.resizeDrawingSurfaceToCanvas();
    },
    setPlaying: (value) => {
      playing = value;
      syncPlayback();
    },
    cleanup: () => {
      loaded = false;
      animation.cleanup();
    },
  };
}
