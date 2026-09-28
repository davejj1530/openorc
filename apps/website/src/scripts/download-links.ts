import { detectDownloadDevice } from "../lib/download-platform";

async function enhanceDownloads() {
  const hint = document.querySelector<HTMLElement>("[data-device-hint]");
  if (!hint) return;
  const device = await detectDownloadDevice(navigator);
  const match = device.target ? document.querySelector<HTMLElement>(`[data-installer="${device.target}"]`) : null;
  if (match?.querySelector("a[data-installer-link]")) {
    match.dataset.recommended = "true";
    match.querySelector<HTMLElement>("[data-recommendation]")?.removeAttribute("hidden");
    hint.textContent = "We’ve highlighted the installer that matches your browser’s device information. All versions are below.";
  } else if (device.platform === "mac") {
    hint.textContent = "Choose your Mac’s chip below. In the Apple menu, open About This Mac and look for Chip or Processor.";
  } else if (device.platform === "windows") {
    hint.textContent = "The Windows installer is for 64-bit Intel and AMD PCs. Check Settings → System → About if you’re unsure.";
  } else if (device.platform === "mobile") {
    hint.textContent = "OpenOrc runs on a computer. Visit this page on your Mac or Windows PC to install it.";
  } else {
    hint.textContent = "OpenOrc is available for macOS and Windows. Choose the installer for the computer you’ll use.";
  }
}

void enhanceDownloads();
