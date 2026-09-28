import { useEffect, useRef, useState, type RefObject } from "react";
import { observeOnScreen, useReducedMotion } from "../lib/motion";
import { useTheme } from "../lib/theme";

/**
 * The commands a canvas animation runtime accepts from its host. The host
 * calls cleanup once, when it releases the runtime.
 */
export interface CanvasAnimation {
  setPlaying(playing: boolean): void;
  resize(): void;
  syncColors(): void;
  cleanup(): void;
}

export interface CanvasAnimationInput {
  canvas: HTMLCanvasElement;
  /** The first frame is drawn, so the canvas can replace the static fallback. */
  onReady: () => void;
  /** Loading or drawing failed, so the static fallback must show again. */
  onError: () => void;
}

type CreateCanvasAnimation<Animation extends CanvasAnimation> = (input: CanvasAnimationInput) => Animation;

interface CanvasAnimationOptions<Animation extends CanvasAnimation> {
  /** The element whose presence on screen decides playback. */
  frame: RefObject<HTMLElement | null>;
  canvas: RefObject<HTMLCanvasElement | null>;
  /**
   * A dynamic import, which keeps the runtime and its WASM off the first
   * screen's critical path. Define it at module scope: a new function on each
   * render would restart the animation every time.
   */
  loadRuntime: () => Promise<CreateCanvasAnimation<Animation>>;
}

interface CanvasAnimationState<Animation extends CanvasAnimation> {
  /** The animation has drawn and replaced the static fallback. Never true under reduced motion. */
  ready: boolean;
  /** The live instance for component-specific commands. The hook creates and releases it. */
  animation: { readonly current: Animation | null };
}

/**
 * Runs a canvas animation over its static fallback. Under reduced motion the
 * runtime never loads. Otherwise the animation plays only while the frame is
 * on screen and follows theme changes. The effect owns the instance together
 * with every observer and listener that drives it, and releases them all on
 * unmount or when reduced motion is turned on.
 */
export function useCanvasAnimation<Animation extends CanvasAnimation>({ frame, canvas, loadRuntime }: CanvasAnimationOptions<Animation>): CanvasAnimationState<Animation> {
  const reducedMotion = useReducedMotion();
  const [painted, setPainted] = useState(false);
  const animation = useRef<Animation | null>(null);

  useEffect(() => {
    const frameElement = frame.current;
    const surface = canvas.current;
    if (reducedMotion || !frameElement || !surface) return;

    let released = false;
    let onScreen = false;
    let instance: Animation | undefined;
    const syncPlayback = () => instance?.setPlaying(onScreen);
    const resize = () => instance?.resize();

    const stopObservingScreen = observeOnScreen(frameElement, (visible) => {
      onScreen = visible;
      syncPlayback();
    });
    const sizing = new ResizeObserver(resize);
    sizing.observe(surface);
    window.addEventListener("resize", resize);
    const unsubscribeTheme = useTheme.subscribe(() => instance?.syncColors());

    void loadRuntime()
      .then((createAnimation) => {
        if (released) return;
        instance = createAnimation({
          canvas: surface,
          onReady: () => {
            if (!released) setPainted(true);
          },
          onError: () => {
            if (!released) setPainted(false);
          },
        });
        animation.current = instance;
        syncPlayback();
      })
      .catch(() => {
        /* The static fallback stays visible when the runtime cannot load or start. */
      });

    return () => {
      released = true;
      stopObservingScreen();
      sizing.disconnect();
      window.removeEventListener("resize", resize);
      unsubscribeTheme();
      instance?.cleanup();
      // An observer callback queued before disconnecting must not reach the released instance.
      instance = undefined;
      animation.current = null;
      // A later instance must draw its own first frame before it replaces the still.
      setPainted(false);
    };
  }, [reducedMotion, frame, canvas, loadRuntime]);

  // CSS shows the still as soon as reduced motion is requested; `ready` agrees before the effect releases the instance.
  return { ready: painted && !reducedMotion, animation };
}
