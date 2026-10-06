import { downloadDevice } from "../lib/download-platform";
import { platformIcons, platformNames } from "../lib/platform-icons";

/** The buttons ship written for macOS. Windows and Linux get their own name and logo; phones and other systems get a plain label. */
const { platform } = downloadDevice(navigator);
if (platform !== "mac") {
  for (const cta of document.querySelectorAll<HTMLElement>("[data-download-cta]")) {
    const label = cta.querySelector("span");
    const icon = cta.querySelector("svg");
    if (!label || !icon) continue;
    if (platform === "windows" || platform === "linux") {
      icon.querySelector("path")?.setAttribute("d", platformIcons[platform]);
      label.textContent = `Download for ${platformNames[platform]}`;
    } else {
      icon.remove();
      label.textContent = "Download OpenOrc";
    }
  }
}
