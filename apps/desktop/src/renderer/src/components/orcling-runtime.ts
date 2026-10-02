import orclingUrl from "../../../../../../assets/mascot/orcling.riv?url&no-inline";
import type { OrclingLook } from "@openorc/protocol";
import { Alignment, Fit, Layout, Rive } from "./bundled-rive";
import type { CanvasAnimation, CanvasAnimationInput } from "./canvas-animation";

/** 0 Idle, 1 Thinking, 2 Working, 3 Happy: the expressions of the Orcling Rive file's "App states" machine. */
export type OrclingExpression = 0 | 1 | 2 | 3;

export interface OrclingAnimation extends CanvasAnimation {
  setLook(look: OrclingLook): void;
  express(expression: OrclingExpression): void;
}

const VARIANTS = ["shape", "eyes", "texture", "glasses", "accessory"] as const;

const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

/**
 * The Orcling Rive character, dressed from a look through its view model. Lazy-loaded only when motion is allowed;
 * the .riv and WASM ship with the app.
 */
export function createOrclingAnimation({ canvas, onReady, onError }: CanvasAnimationInput): OrclingAnimation {
  let loaded = false;
  let revealed = false;
  let playing = false;
  let disposed = false;
  let look: OrclingLook | null = null;
  let expression: OrclingExpression = 0;
  const apply = () => {
    const model = animation.viewModelInstance;
    if (!loaded || disposed || !model) return;
    if (look) {
      for (const part of VARIANTS) {
        const property = model.number(part);
        if (property) property.value = look[part];
      }
      model.color("bodyColor")?.rgb(...rgb(look.bodyColor));
      model.color("eyeColor")?.rgb(...rgb(look.eyeColor));
    }
    const current = model.number("expression");
    if (current) current.value = expression;
  };
  const syncPlayback = () => {
    if (!loaded || disposed) return;
    if (playing) {
      apply();
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
    src: orclingUrl,
    artboard: "Orcling",
    stateMachines: "App states",
    autoBind: true,
    autoplay: false,
    enableRiveAssetCDN: false,
    shouldDisableRiveListeners: true,
    layout: new Layout({ fit: Fit.Contain, alignment: Alignment.Center }),
    onLoad: () => {
      if (disposed) return;
      if (!animation.viewModelInstance?.number("shape") || !animation.viewModelInstance.color("bodyColor")) {
        loaded = false;
        onError();
        return;
      }
      loaded = true;
      resize();
    },
    onLoadError: () => {
      if (disposed) return;
      loaded = false;
      animation.stopRendering();
      onError();
    },
    onAdvance: () => {
      if (!disposed && loaded && playing && !revealed) {
        revealed = true;
        onReady();
      }
    },
  });

  return {
    resize,
    // Colors come from the look, not the theme; a theme change only redraws.
    syncColors: apply,
    setPlaying(value) {
      if (disposed) return;
      playing = value;
      syncPlayback();
    },
    setLook(next) {
      look = next;
      apply();
    },
    express(next) {
      expression = next;
      apply();
    },
    cleanup() {
      if (disposed) return;
      disposed = true;
      loaded = false;
      animation.cleanup();
    },
  };
}
