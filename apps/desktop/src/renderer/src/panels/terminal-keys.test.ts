import { expect, it } from "vitest";
import { terminalKey } from "./terminal-keys";

const press = (key: string, held: Partial<Record<"ctrlKey" | "metaKey" | "shiftKey" | "altKey", boolean>> = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...held });

it("leaves Ctrl+C to the shell on Linux, and copies and pastes behind Ctrl+Shift", () => {
  expect(terminalKey(press("c", { ctrlKey: true }), "linux", true)).toBeNull();
  expect(terminalKey(press("v", { ctrlKey: true }), "linux", false)).toBeNull();
  expect(terminalKey(press("C", { ctrlKey: true, shiftKey: true }), "linux", true)).toEqual({ kind: "copy", thenClear: false });
  expect(terminalKey(press("V", { ctrlKey: true, shiftKey: true }), "linux", false)).toEqual({ kind: "paste" });
  expect(terminalKey(press("F", { ctrlKey: true, shiftKey: true }), "linux", false)).toEqual({ kind: "find" });
});

it("copies with Ctrl+C on Windows only while text is selected, so it still interrupts without", () => {
  expect(terminalKey(press("c", { ctrlKey: true }), "win32", true)).toEqual({ kind: "copy", thenClear: true });
  expect(terminalKey(press("c", { ctrlKey: true }), "win32", false)).toBeNull();
  expect(terminalKey(press("v", { ctrlKey: true }), "win32", false)).toEqual({ kind: "paste" });
  // AltGr types a character.
  expect(terminalKey(press("v", { ctrlKey: true, altKey: true }), "win32", false)).toBeNull();
});

it("keeps a Mac's copy and paste the browser's own, and names its find and line keys", () => {
  expect(terminalKey(press("c", { metaKey: true }), "darwin", true)).toBeNull();
  expect(terminalKey(press("v", { metaKey: true }), "darwin", false)).toBeNull();
  expect(terminalKey(press("f", { metaKey: true }), "darwin", false)).toEqual({ kind: "find" });
  expect(terminalKey(press("Backspace", { metaKey: true }), "darwin", false)).toEqual({ kind: "type", data: "\x15" });
  expect(terminalKey(press("ArrowLeft", { metaKey: true }), "darwin", false)).toEqual({ kind: "type", data: "\x01" });
  expect(terminalKey(press("c", { ctrlKey: true }), "darwin", true)).toBeNull();
});
