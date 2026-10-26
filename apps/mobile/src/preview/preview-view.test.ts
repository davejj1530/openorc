import type { PreviewState } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { previewLine, previewView, refusalWords, safariAddress } from "./preview-view";

const page = (patch: Partial<Extract<PreviewState, { open: true }>> = {}): PreviewState => ({
  open: true,
  pane: "p1",
  address: "http://127.0.0.1:47831/tick?ms=250",
  title: "QA Tick",
  phase: "live",
  error: null,
  frame: { seq: 4, width: 786, height: 566 },
  ...patch,
});
const seen: { refused: string | null; shown: boolean; connected: boolean; active: boolean } = { refused: null, shown: true, connected: true, active: true };
const view = (state: PreviewState | undefined, input: Partial<typeof seen> = {}) => previewView({ ...seen, ...input, state });

describe("the Preview screen's state", () => {
  it("opens on the ground, named by the label the thread screen read", () => {
    expect(view(undefined, { shown: false })).toEqual({ kind: "opening" });
    expect(previewLine({ kind: "opening" }, undefined, page({ title: "" }))).toBe("127.0.0.1:47831");
    expect(previewLine({ kind: "opening" }, undefined, undefined)).toBeNull();
  });

  it("says the page closed, and drops the frame and the line", () => {
    expect(view({ open: false })).toEqual({ kind: "closed" });
    expect(previewLine({ kind: "closed" }, { open: false }, page())).toBeNull();
  });

  it("loads a page with no frame yet under its host, and keeps a shown frame while the next page loads", () => {
    const loading = page({ phase: "loading", title: "" });
    expect(view(loading, { shown: false })).toEqual({ kind: "loading", host: "127.0.0.1:47831" });
    expect(previewLine(view(loading, { shown: false }), loading, undefined)).toBe("127.0.0.1:47831");
    expect(view(loading)).toEqual({ kind: "page", navigating: true, dim: false });
    expect(previewLine(view(loading), loading, undefined)).toBe("Loading 127.0.0.1:47831…");
  });

  it("shows a live page under its title, else its host, and waits on the ground for its first frame", () => {
    expect(view(page())).toEqual({ kind: "page", navigating: false, dim: false });
    expect(previewLine(view(page()), page(), undefined)).toBe("QA Tick");
    expect(previewLine(view(page({ title: "" })), page({ title: "" }), undefined)).toBe("127.0.0.1:47831");
    expect(view(page(), { shown: false })).toEqual({ kind: "opening" });
  });

  it("says when the page failed in the Mac's words, or stopped, under its host", () => {
    const failed = page({ phase: "failed", error: "Nothing is listening on localhost:5173 yet." });
    expect(view(failed)).toEqual({ kind: "failed", message: "Nothing is listening on localhost:5173 yet." });
    expect(previewLine(view(failed), failed, undefined)).toBe("127.0.0.1:47831");
    expect(view(page({ phase: "stopped" }))).toEqual({ kind: "stopped" });
  });

  it("dims the last frame while the Mac is out of reach", () => {
    expect(view(page(), { connected: false })).toEqual({ kind: "page", navigating: false, dim: true });
  });

  it("shows only the ground while the app is not in front", () => {
    expect(view(page(), { active: false })).toEqual({ kind: "opening" });
  });

  it("says why the Mac refused the watch, and asks an older Mac to update", () => {
    expect(view(page(), { refused: "This thread is gone." })).toEqual({ kind: "refused", message: "This thread is gone." });
    expect(previewLine({ kind: "refused", message: "This thread is gone." }, page(), page())).toBeNull();
    expect(refusalWords("This thread is gone.", "Studio")).toBe("This thread is gone.");
    expect(refusalWords("This is not available from a phone.", "Studio")).toBe("Update OpenOrc on Studio to see its Preview.");
  });

  it("opens in Safari only a public address the Mac's shaping left whole", () => {
    expect(safariAddress(page({ address: "https://example.com/docs?page=2" }))).toBe("https://example.com/docs?page=2");
    expect(safariAddress(page({ address: "http://127.0.0.1:47831/" }))).toBeNull();
    expect(safariAddress(page({ address: "http://localhost:5173/" }))).toBeNull();
    expect(safariAddress(page({ address: "https://example.com/callback?code=[redacted:query]" }))).toBeNull();
    expect(safariAddress({ open: false })).toBeNull();
    expect(safariAddress(undefined)).toBeNull();
  });
});
