import { afterEach, describe, expect, it, vi } from "vitest";
import { readNewThreadDraft, writeNewThreadDraft } from "./new-thread-draft";

afterEach(() => vi.unstubAllGlobals());

describe("new task execution drafts", () => {
  it("keeps a retired team draft and its images while requiring a new selection", () => {
    const images = JSON.stringify({ attachments: [{ path: "/saved.png", url: "image://local", name: "Saved image" }] });
    const storage = new Map([
      ["openorc.draft.newthread.project.execution", JSON.stringify({ prompt: "Keep this request", target: { kind: "team", revision: { id: "old-team" } } })],
      ["openorc.draft.newthread.project.attachments", images],
    ]);
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const draft = readNewThreadDraft("project");
    expect(draft.prompt).toBe("Keep this request");
    expect(draft.target).toMatchObject({ kind: "unavailable", reason: expect.stringContaining("Choose a model") });
    expect(storage.get("openorc.draft.newthread.project.attachments")).toBe(images);
  });

  it("migrates the existing prompt and keeps attachment storage and other projects separate", () => {
    const storage = new Map<string, string>([
      ["openorc.draft.new", JSON.stringify({ "project-1": "Legacy request", "project-2": "Other request" })],
      ["openorc.draft.newthread.project-1.attachments", JSON.stringify({ attachments: [{ path: "/image.png", url: "image://local", name: "Image" }] })],
    ]);
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const draft = readNewThreadDraft("project-1");
    expect(draft.prompt).toBe("Legacy request");
    expect(writeNewThreadDraft({ ...draft, target: { kind: "model", choice: { agent: "codex", model: "fixture", effort: "high", fastMode: true } } })).toBe(true);
    expect(readNewThreadDraft("project-1").target).toEqual({ kind: "model", choice: { agent: "codex", model: "fixture", effort: "high", fastMode: true } });
    expect(readNewThreadDraft("project-2").prompt).toBe("Other request");
    expect(JSON.parse(storage.get("openorc.draft.newthread.project-1.attachments")!)).toEqual({ attachments: [{ path: "/image.png", url: "image://local", name: "Image" }] });
    expect(writeNewThreadDraft({ ...draft, prompt: "" })).toBe(true);
    expect(readNewThreadDraft("project-1").prompt).toBe("");
  });
});
