import mascotUrl from "../../../../../../assets/mascot/questling.riv?url&no-inline";
import { toHex } from "../lib/color";
import { Alignment, Fit, Layout, Rive } from "./bundled-rive";
import type { CanvasAnimation, CanvasAnimationInput } from "./canvas-animation";

export type MascotReaction = "EffortChange" | "FastOn" | "FastOff" | "Thinking" | "Working" | "Happy";
export interface MascotAnimation extends CanvasAnimation {
  react(reaction: MascotReaction): void;
}

const reactions = {
  EffortChange: { duration: 1600, expression: 1 },
  FastOn: { duration: 1600, expression: 3 },
  FastOff: { duration: 1000, expression: 2 },
  Thinking: { duration: 1600, expression: 1 },
  Working: { duration: 1000, expression: 2 },
  Happy: { duration: 1600, expression: 3 },
} as const;

/** Lazy-loaded only when motion is allowed; the .riv and WASM both ship with the app. */
export function createMascotAnimation({ canvas, onReady, onError }: CanvasAnimationInput): MascotAnimation {
  let loaded = false;
  let revealed = false;
  let playing = false;
  let disposed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const syncColors = () => {
    if (!loaded || disposed) return;
    const style = getComputedStyle(canvas);
    for (const [property, token] of [
      ["bodyColor", "--mascot-body"],
      ["eyeColor", "--mascot-eyes"],
    ] as const) {
      const hex = toHex(style.getPropertyValue(token).trim());
      if (hex) animation.viewModelInstance?.color(property)?.rgb(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
    }
  };
  const express = (value: number) => {
    const expression = animation.viewModelInstance?.number("expression");
    if (expression) expression.value = value;
  };
  const rest = () => {
    clearTimeout(timeout);
    timeout = undefined;
    if (loaded) express(0);
  };
  const failed = () => {
    if (disposed) return;
    rest();
    loaded = false;
    animation.stopRendering();
    onError();
  };
  const syncPlayback = () => {
    if (!loaded || disposed) return;
    if (playing) {
      syncColors();
      animation.play("App states");
      animation.startRendering();
    } else {
      animation.pause("App states");
      animation.stopRendering();
    }
  };
  const resize = () => {
    if (!loaded || disposed) return;
    animation.resizeDrawingSurfaceToCanvas(Math.min(window.devicePixelRatio || 1, 2));
    syncPlayback();
  };
  const animation = new Rive({
    canvas,
    src: mascotUrl,
    artboard: "Questling POC",
    stateMachines: "App states",
    autoBind: true,
    autoplay: false,
    enableRiveAssetCDN: false,
    shouldDisableRiveListeners: true,
    layout: new Layout({ fit: Fit.Contain, alignment: Alignment.Center }),
    onLoad: () => {
      if (disposed) return;
      if (!animation.viewModelInstance?.number("expression") || !animation.viewModelInstance.color("bodyColor") || !animation.viewModelInstance.color("eyeColor")) {
        failed();
        return;
      }
      loaded = true;
      express(0);
      resize();
    },
    onLoadError: failed,
    onAdvance: () => {
      if (!disposed && loaded && playing && !revealed) {
        revealed = true;
        onReady();
      }
    },
  });

  return {
    resize,
    syncColors,
    setPlaying(value) {
      if (disposed) return;
      playing = value;
      if (!value) rest();
      syncPlayback();
    },
    react(reaction) {
      if (disposed || !revealed || !loaded || !playing) return;
      rest();
      express(reactions[reaction].expression);
      timeout = setTimeout(rest, reactions[reaction].duration);
    },
    cleanup() {
      if (disposed) return;
      rest();
      disposed = true;
      loaded = false;
      animation.cleanup();
    },
  };
}
