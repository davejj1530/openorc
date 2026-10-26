import { describe, expect, it } from "vitest";
import { androidKey, androidText, androidTouch, hidUsage, iosKey, iosTouch, isVideoSession, nextOrientation, parseIosControl, type ScreenGeometry } from "./input";

const decode = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  return { tag: bytes[0], payload: JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as unknown };
};
const tagged = (tag: number, payload: unknown) => Uint8Array.from([tag, ...new TextEncoder().encode(JSON.stringify(payload))]);

describe("iOS input", () => {
  it("sends touches in the portrait framebuffer's space whatever way the device faces", () => {
    const portraitFrame = (orientation: ScreenGeometry["orientation"]): ScreenGeometry => ({ width: 1206, height: 2622, orientation });
    expect(decode(iosTouch("begin", { x: 0.25, y: 0.75 }, null))).toEqual({ tag: 0x03, payload: { type: "begin", x: 0.25, y: 0.75 } });
    expect(decode(iosTouch("move", { x: 0.25, y: 0.75 }, portraitFrame("landscape_left"))).payload).toEqual({ type: "move", x: 0.75, y: 0.75 });
    expect(decode(iosTouch("move", { x: 0.25, y: 0.75 }, portraitFrame("landscape_right"))).payload).toEqual({ type: "move", x: 0.25, y: 0.25 });
    expect(decode(iosTouch("end", { x: 0.25, y: 0.75 }, portraitFrame("portrait_upside_down"))).payload).toEqual({ type: "end", x: 0.75, y: 0.25 });
    // A framebuffer that is already landscape needs no remapping.
    expect(decode(iosTouch("end", { x: 0.25, y: 0.75 }, { width: 2622, height: 1206, orientation: "landscape_left" })).payload).toEqual({ type: "end", x: 0.25, y: 0.75 });
  });

  it("maps physical keys to HID usages and ignores keys the simulator cannot take", () => {
    expect(hidUsage("KeyA")).toBe(0x04);
    expect(hidUsage("KeyZ")).toBe(0x1d);
    expect(hidUsage("Digit1")).toBe(0x1e);
    expect(hidUsage("Digit0")).toBe(0x27);
    expect(hidUsage("Enter")).toBe(0x28);
    expect(hidUsage("F13")).toBeNull();
    expect(decode(iosKey("KeyA", "down")!)).toEqual({ tag: 0x06, payload: { type: "down", usage: 0x04 } });
    expect(iosKey("F13", "down")).toBeNull();
  });

  it("rotates through the four orientations", () => {
    expect(nextOrientation("portrait")).toBe("landscape_left");
    expect(nextOrientation("landscape_right")).toBe("portrait");
  });

  it("reads input admission and screen config, and ignores anything malformed", () => {
    expect(parseIosControl(Uint8Array.of(0x83))).toEqual({ kind: "admitted" });
    expect(parseIosControl(tagged(0x82, { width: 1206, height: 2622, orientation: "portrait", inputUnavailable: true }))).toEqual({
      kind: "screen",
      screen: { width: 1206, height: 2622, orientation: "portrait" },
      inputUnavailable: true,
    });
    expect(parseIosControl(tagged(0x82, { width: 0, height: 2622, orientation: "portrait" }))).toEqual({ kind: "other" });
    expect(parseIosControl(tagged(0x82, { width: 1, height: 2, orientation: "sideways" }))).toEqual({ kind: "other" });
    expect(parseIosControl(Uint8Array.of(0x82, 0x7b))).toEqual({ kind: "other" });
    expect(parseIosControl(tagged(0x90, { requestId: 1 }))).toEqual({ kind: "other" });
  });
});

describe("Android input", () => {
  it("sends touches as down, move and up", () => {
    expect(JSON.parse(androidTouch("begin", { x: 0.5, y: 0.25 }))).toEqual({ type: "touch", action: "down", x: 0.5, y: 0.25 });
    expect(JSON.parse(androidTouch("end", { x: 0.5, y: 0.25 })).action).toBe("up");
  });

  it("turns Escape into Back, editing keys into key codes and printable keys into text", () => {
    const key = (key: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {}) => androidKey({ key, metaKey: false, ctrlKey: false, ...modifiers });
    expect(JSON.parse(key("Escape")!)).toEqual({ type: "back" });
    expect(JSON.parse(key("Backspace")!)).toEqual({ type: "key", keycode: 67 });
    expect(JSON.parse(key("é")!)).toEqual({ type: "text", text: "é" });
    expect(key("c", { metaKey: true })).toBeNull();
    expect(key("Shift")).toBeNull();
  });

  it("splits pasted text into messages of at most 300 UTF-8 bytes without breaking a character", () => {
    const messages = androidText(`${"a".repeat(299)}é${"b".repeat(10)}`).map((message) => (JSON.parse(message) as { text: string }).text);
    expect(messages).toEqual(["a".repeat(299), `é${"b".repeat(10)}`]);
    expect(androidText("x".repeat(300 * 70))).toHaveLength(64);
  });

  it("recognises the encoder restart announcement", () => {
    expect(isVideoSession('{"type":"video-session","width":1080}')).toBe(true);
    expect(isVideoSession("not json")).toBe(false);
  });
});
