import { visualizationColors, type VisualizationContext } from "@openorc/client";

/** The window's theme as a visualization takes it: light or dark, the interface font and the palette's colors. */
export function visualizationContext(): VisualizationContext {
  const style = getComputedStyle(document.documentElement);
  return {
    theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
    font: getComputedStyle(document.body).fontFamily,
    colors: visualizationColors((token) => style.getPropertyValue(`--${token}`).trim()),
  };
}
