import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCodeFont } from "../lib/code-font";
import { followTerminalFont } from "./terminal-font";

const root = document.documentElement;
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
const load = vi.fn<(font: string) => Promise<unknown>>();
let stop = (): void => {};

beforeEach(() => {
  useCodeFont.getState().setFont("jetbrains-mono");
  root.style.setProperty("--font-mono", '"JetBrains Mono Variable", monospace');
  load.mockReset().mockResolvedValue([]);
  Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
});
afterEach(() => {
  stop();
  root.style.removeProperty("--font-mono");
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
});

it("loads the selected font before assigning it and measuring terminal cells", async () => {
  let ready = (): void => {};
  load.mockImplementationOnce(() => new Promise((resolve) => (ready = () => resolve([]))));
  const term = { options: { fontFamily: "monospace", fontSize: 12 } };
  const fit = vi.fn();
  stop = followTerminalFont(term, fit);
  expect(load).toHaveBeenCalledWith('12px "JetBrains Mono Variable", monospace');
  expect(term.options.fontFamily).toBe("monospace");
  expect(fit).not.toHaveBeenCalled();
  ready();
  await Promise.resolve();
  expect(term.options.fontFamily).toBe('"JetBrains Mono Variable", monospace');
  expect(fit).toHaveBeenCalledOnce();
});

it("ignores slow font loads after a newer choice or terminal disposal", async () => {
  const pending: (() => void)[] = [];
  load.mockImplementation(() => new Promise((resolve) => pending.push(() => resolve([]))));
  const term = { options: { fontFamily: "monospace", fontSize: 12 } };
  const fit = vi.fn();
  stop = followTerminalFont(term, fit);
  root.style.setProperty("--font-mono", '"Geist Mono Variable", monospace');
  useCodeFont.getState().setFont("geist-mono");
  pending[1]!();
  await Promise.resolve();
  pending[0]!();
  await Promise.resolve();
  expect(term.options.fontFamily).toBe('"Geist Mono Variable", monospace');
  expect(fit).toHaveBeenCalledOnce();
  root.style.setProperty("--font-mono", "ui-monospace, monospace");
  useCodeFont.getState().setFont("system");
  stop();
  pending[2]!();
  await Promise.resolve();
  expect(term.options.fontFamily).toBe('"Geist Mono Variable", monospace');
  expect(fit).toHaveBeenCalledOnce();
});

it("still fits the fallback when the selected font fails to load", async () => {
  load.mockRejectedValueOnce(new Error("Font unavailable"));
  const term = { options: { fontFamily: "monospace", fontSize: 12 } };
  const fit = vi.fn();
  stop = followTerminalFont(term, fit);
  await Promise.resolve();
  expect(term.options.fontFamily).toBe('"JetBrains Mono Variable", monospace');
  expect(fit).toHaveBeenCalledOnce();
});
