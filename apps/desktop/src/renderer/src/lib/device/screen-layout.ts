import type { Device, DevicePlatform } from "@openorc/protocol";
import type { ScreenGeometry } from "./input";

type Size = { width: number; height: number };

const landscape = (screen: ScreenGeometry) => screen.orientation === "landscape_left" || screen.orientation === "landscape_right";

/** Width over height of the screen as the user sees it, with a guess from the device's shape before the first report. */
export function screenAspect(device: Pick<Device, "platform" | "formFactor">, screen: ScreenGeometry | null): number {
  if (!screen && device.formFactor === "tablet") return 3 / 4;
  if (!screen) return device.platform === "ios" ? 9 / 19.5 : 9 / 20;
  const long = Math.max(screen.width, screen.height);
  const short = Math.min(screen.width, screen.height);
  return landscape(screen) ? long / short : short / long;
}

/** serve-sim sends the raw portrait framebuffer even when the device faces another way, so the view turns it. */
export function screenRotation(platform: DevicePlatform, screen: ScreenGeometry | null): number {
  if (platform !== "ios" || !screen || screen.width > screen.height) return 0;
  if (screen.orientation === "landscape_left") return 90;
  if (screen.orientation === "landscape_right") return -90;
  return screen.orientation === "portrait_upside_down" ? 180 : 0;
}

/** The largest frame of this aspect that fits the area. */
export function fitFrame(aspect: number, area: Size): Size {
  if (area.width <= 0 || area.height <= 0) return { width: 0, height: 0 };
  const byHeight = { width: area.height * aspect, height: area.height };
  return byHeight.width <= area.width ? byHeight : { width: area.width, height: area.width / aspect };
}

/** Where the media sits inside the frame: turned a quarter, its box swaps sides around the frame's center. */
export function mediaBox(frame: Size, rotation: number): { width: number; height: number; left: number; top: number; transform?: string } {
  const sideways = rotation === 90 || rotation === -90;
  const width = sideways ? frame.height : frame.width;
  const height = sideways ? frame.width : frame.height;
  const box = { width, height, left: (frame.width - width) / 2, top: (frame.height - height) / 2 };
  return rotation ? { ...box, transform: `rotate(${rotation}deg)` } : box;
}

/** Screen corners in proportion to the device: a phone's are deep, a tablet's shallow. */
export const screenCorner = (frame: Size, formFactor: Device["formFactor"]): number => Math.round(Math.min(frame.width, frame.height) * (formFactor === "tablet" ? 0.035 : 0.1));
