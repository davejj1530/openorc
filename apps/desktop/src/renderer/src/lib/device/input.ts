/**
 * What the device helpers expect on their sockets. iOS: one tag byte, then JSON (touches, buttons, HID keys,
 * orientation), and the helper answers with tagged screen config. Android: JSON text messages.
 */

export type Orientation = "portrait" | "portrait_upside_down" | "landscape_left" | "landscape_right";
export type TouchPhase = "begin" | "move" | "end";
/** A point in the displayed frame, 0 to 1 on each axis. */
export type Point = { x: number; y: number };

/** The iOS screen as the helper reports it. Android's comes from the decoded frame size. */
export type ScreenGeometry = { width: number; height: number; orientation: Orientation };

const IOS_TOUCH = 0x03;
const IOS_BUTTON = 0x04;
const IOS_KEY = 0x06;
const IOS_ORIENTATION = 0x07;
const IOS_SCREEN_CONFIG = 0x82;
const IOS_INPUT_ADMITTED = 0x83;

const ORIENTATIONS: readonly Orientation[] = ["portrait", "landscape_left", "portrait_upside_down", "landscape_right"];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function tagged(tag: number, payload: unknown): ArrayBuffer {
  const json = encoder.encode(JSON.stringify(payload));
  const out = new Uint8Array(1 + json.length);
  out[0] = tag;
  out.set(json, 1);
  return out.buffer;
}

/** serve-sim streams the raw portrait framebuffer, so a rotated device takes its touches in that raw space. */
function rawPoint(point: Point, screen: ScreenGeometry | null): Point {
  const { x, y } = point;
  if (!screen || screen.width > screen.height) return point;
  if (screen.orientation === "landscape_left") return { x: y, y: 1 - x };
  if (screen.orientation === "landscape_right") return { x: 1 - y, y: x };
  if (screen.orientation === "portrait_upside_down") return { x: 1 - x, y: 1 - y };
  return point;
}

export const iosTouch = (phase: TouchPhase, point: Point, screen: ScreenGeometry | null): ArrayBuffer => tagged(IOS_TOUCH, { type: phase, ...rawPoint(point, screen) });

export const iosHome = (): ArrayBuffer => tagged(IOS_BUTTON, { button: "home" });

export const iosOrientation = (orientation: Orientation): ArrayBuffer => tagged(IOS_ORIENTATION, { orientation });

export const nextOrientation = (current: Orientation): Orientation => ORIENTATIONS[(ORIENTATIONS.indexOf(current) + 1) % ORIENTATIONS.length]!;

const HID_USAGE: Readonly<Record<string, number>> = {
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  Delete: 0x4c,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  ControlLeft: 0xe0,
  ShiftLeft: 0xe1,
  AltLeft: 0xe2,
  MetaLeft: 0xe3,
  ControlRight: 0xe4,
  ShiftRight: 0xe5,
  AltRight: 0xe6,
  MetaRight: 0xe7,
};

/** The HID usage for a physical key (`KeyboardEvent.code`), or null for keys the simulator cannot take. */
export function hidUsage(code: string): number | null {
  if (/^Key[A-Z]$/.test(code)) return 0x04 + (code.charCodeAt(3) - 65);
  if (/^Digit[1-9]$/.test(code)) return 0x1e + (code.charCodeAt(5) - 49);
  if (code === "Digit0") return 0x27;
  return HID_USAGE[code] ?? null;
}

export function iosKey(code: string, phase: "down" | "up"): ArrayBuffer | null {
  const usage = hidUsage(code);
  return usage === null ? null : tagged(IOS_KEY, { type: phase, usage });
}

export type IosControlEvent = { kind: "admitted" } | { kind: "screen"; screen: ScreenGeometry; inputUnavailable: boolean } | { kind: "other" };

const isOrientation = (value: unknown): value is Orientation => ORIENTATIONS.includes(value as Orientation);
const isSize = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** Reads one message from the iOS helper. Anything unexpected is `other` and ignored. */
export function parseIosControl(bytes: Uint8Array): IosControlEvent {
  if (bytes[0] === IOS_INPUT_ADMITTED) return { kind: "admitted" };
  if (bytes[0] !== IOS_SCREEN_CONFIG) return { kind: "other" };
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(decoder.decode(bytes.subarray(1))) as Record<string, unknown>;
  } catch {
    return { kind: "other" };
  }
  const { width, height, orientation, inputUnavailable } = config;
  if (!isSize(width) || !isSize(height) || !isOrientation(orientation)) return { kind: "other" };
  return { kind: "screen", screen: { width, height, orientation }, inputUnavailable: inputUnavailable === true };
}

const ANDROID_TOUCH_ACTION: Record<TouchPhase, string> = { begin: "down", move: "move", end: "up" };

export const androidTouch = (phase: TouchPhase, point: Point): string => JSON.stringify({ type: "touch", action: ANDROID_TOUCH_ACTION[phase], x: point.x, y: point.y });

export type AndroidButton = "back" | "home" | "recents";
export const androidButton = (button: AndroidButton): string => JSON.stringify({ type: button });

export const androidKeyframeRequest = (): string => JSON.stringify({ type: "reset-video", ack: false });

const ANDROID_KEYCODE: Readonly<Record<string, number>> = {
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Tab: 61,
  Enter: 66,
  Backspace: 67,
  Delete: 112,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
};

/** A key press for the emulator: Escape goes back, editing keys go as key codes, printable keys as text. */
export function androidKey(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">): string | null {
  if (event.key === "Escape") return androidButton("back");
  const keycode = ANDROID_KEYCODE[event.key];
  if (keycode !== undefined) return JSON.stringify({ type: "key", keycode });
  if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) return JSON.stringify({ type: "text", text: event.key });
  return null;
}

// serve-emu takes at most 300 UTF-8 bytes per text message and queues 128; a paste stays well inside both.
const ANDROID_MAX_TEXT_BYTES = 300;
const ANDROID_MAX_TEXT_CHUNKS = 64;

/** Pasted text as emulator text messages, split on character boundaries. */
export function androidText(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of text) {
    const size = encoder.encode(character).length;
    if (bytes + size > ANDROID_MAX_TEXT_BYTES) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks.slice(0, ANDROID_MAX_TEXT_CHUNKS).map((part) => JSON.stringify({ type: "text", text: part }));
}

/** Whether a helper message announces that the emulator's encoder restarted, so the decoder must start over. */
export function isVideoSession(text: string): boolean {
  try {
    return (JSON.parse(text) as { type?: unknown }).type === "video-session";
  } catch {
    return false;
  }
}
