import { create } from "zustand";

interface WindowState {
  fullscreen: boolean;
  /** CSS pixels Linux's window controls cover at each end of the header. Always zero elsewhere. */
  controls: { left: number; right: number };
}

/** What the OS draws over our headers right now, so the columns can make room for it or take it back. */
export const useWindow = create<WindowState>(() => ({ fullscreen: false, controls: { left: 0, right: 0 } }));

export function installWindowState(): void {
  const syncChrome = () => {
    void window.openorc.syncWindowChrome().then((zoom) => {
      document.documentElement.style.setProperty("--window-zoom", String(zoom));
    });
  };
  syncChrome();
  // Chromium emits resize when page zoom changes, including menu shortcuts and
  // zoom reset. Listening here also covers windows that share the same origin.
  window.addEventListener("resize", syncChrome);
  void window.openorc.isFullscreen().then((fullscreen) => useWindow.setState({ fullscreen }));
  window.openorc.onFullscreen((fullscreen) => {
    useWindow.setState({ fullscreen });
    syncChrome();
  });
  if (platform === "linux") installLinuxControls();
}

const platform = window.openorc.platform;
/** Room between Linux's window controls and the header content beside them. */
const CONTROLS_GAP = 8;

/**
 * Linux draws its window controls where the desktop's button layout puts them: at the right by default, at the left,
 * or split between both ends. The overlay reports the header area they leave free, in CSS pixels at the current zoom,
 * so the headers clear exactly that instead of a fixed width. It reports nothing visible in fullscreen.
 */
function installLinuxControls(): void {
  const overlay = navigator.windowControlsOverlay;
  if (!overlay) return;
  const sync = () => {
    const free = overlay.visible ? overlay.getTitlebarAreaRect() : null;
    const left = free ? Math.max(0, Math.round(free.left)) : 0;
    const right = free ? Math.max(0, Math.round(window.innerWidth - free.right)) : 0;
    document.documentElement.style.setProperty("--window-controls-left", `${left + CONTROLS_GAP}px`);
    document.documentElement.style.setProperty("--window-controls-right", `${right + CONTROLS_GAP}px`);
    const { controls } = useWindow.getState();
    if (controls.left !== left || controls.right !== right) useWindow.setState({ controls: { left, right } });
  };
  sync();
  overlay.addEventListener("geometrychange", sync);
  window.addEventListener("resize", sync);
}

/**
 * macOS draws its traffic lights over the leftmost header, except in fullscreen, where they are gone. Linux draws its
 * window controls there too when the desktop puts them on the left.
 */
export function useTrafficLights(): boolean {
  const fullscreen = useWindow((s) => s.fullscreen);
  const linuxControls = useWindow((s) => s.controls.left > 0);
  return !fullscreen && (platform === "darwin" || linuxControls);
}

/** Windows draws its minimise, maximise, and close over the rightmost header. So does Linux, unless the desktop moves them. */
export function useWindowsControls(): boolean {
  const fullscreen = useWindow((s) => s.fullscreen);
  const linuxControls = useWindow((s) => s.controls.right > 0);
  return !fullscreen && (platform === "win32" || linuxControls);
}
