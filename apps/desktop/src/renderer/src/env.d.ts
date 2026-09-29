/// <reference types="vite/client" />

/** Chromium's Window Controls Overlay, which TypeScript's DOM library does not declare yet. */
interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
}

interface Navigator {
  readonly windowControlsOverlay?: WindowControlsOverlay;
}
