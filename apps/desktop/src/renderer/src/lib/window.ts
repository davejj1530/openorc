import { create } from "zustand";

interface WindowState {
  fullscreen: boolean;
}

/** What the OS draws over our headers right now, so the columns can make room for it or take it back. */
export const useWindow = create<WindowState>(() => ({ fullscreen: false }));

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
}

const platform = window.openorc.platform;

/** macOS draws its traffic lights over the leftmost header, except in fullscreen, where they are gone. */
export function useTrafficLights(): boolean {
  const fullscreen = useWindow((s) => s.fullscreen);
  return platform === "darwin" && !fullscreen;
}

/** Windows draws its minimise, maximise, and close over the rightmost header. */
export function useWindowsControls(): boolean {
  const fullscreen = useWindow((s) => s.fullscreen);
  return platform === "win32" && !fullscreen;
}
