import { WORKSPACE_ID } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { projectChoices } from "../projects";
import { decodeSheetDraft, openingProject, startBlocker, unstarted } from "./new-thread-state";

const choices = projectChoices([
  { id: "openorc", name: "openorc" },
  { id: "website", name: "website" },
]);
const image = { path: "/attachments/0b1c.jpg", preview: "file:///cache/0b1c.jpg" };

describe("the new thread sheet", () => {
  it("lists Workspace first, then the Mac's projects", () => {
    expect(choices).toEqual([
      { id: WORKSPACE_ID, name: "Workspace" },
      { id: "openorc", name: "openorc" },
      { id: "website", name: "website" },
    ]);
  });

  it("opens on the project it was opened for, else the last one shown while the Mac lists it, else Workspace", () => {
    expect(openingProject("website", "openorc", choices)).toBe("website");
    expect(openingProject(undefined, "openorc", choices)).toBe("openorc");
    expect(openingProject(undefined, "removed", choices)).toBe(WORKSPACE_ID);
    expect(openingProject(undefined, "openorc", undefined)).toBe("openorc");
    expect(openingProject(undefined, null, choices)).toBe(WORKSPACE_ID);
  });

  it("keeps the prompt, model, mode and images it saved, and drops what it cannot read", () => {
    const saved = { prompt: "Fix the build", target: { kind: "model", choice: { agent: "claude", model: "opus", effort: "high" } }, mode: "plan", images: [image, { path: 3 }, "x"] };
    const draft = decodeSheetDraft("openorc", JSON.parse(JSON.stringify(saved)));
    expect(draft).toMatchObject({
      projectId: "openorc",
      prompt: "Fix the build",
      target: { kind: "model", choice: { agent: "claude", model: "opus", effort: "high", fastMode: false } },
      mode: "plan",
      images: [image],
    });
    expect(decodeSheetDraft("openorc", null)).toMatchObject({ prompt: "", target: { kind: "model", choice: null }, mode: "act", workspace: null, images: [] });
  });

  it("holds Start until the saved permission loads and a model is chosen, and says why a saved choice is gone", () => {
    const chosen = decodeSheetDraft("openorc", { target: { kind: "model", choice: { agent: "codex", model: "gpt", effort: null } } });
    const loaded = { permissionReady: true };
    expect(startBlocker(chosen, { permissionReady: false })).toBe("Loading saved permissions…");
    expect(startBlocker(chosen, loaded)).toBeNull();
    expect(startBlocker(decodeSheetDraft("openorc", null), loaded)).toBe("Choose a model");
    const broken = decodeSheetDraft("openorc", { target: { kind: "model", choice: { model: "missing-provider" } } });
    expect(startBlocker(broken, loaded)).toBe("This saved model selection cannot be restored. Choose a model again; your message and images are kept.");
  });

  it("puts back what a refused start took, ahead of anything written or attached since", () => {
    const later = { path: "/attachments/later.jpg", preview: "file:///cache/later.jpg" };
    const since = { ...decodeSheetDraft("openorc", null), mode: "plan" as const, prompt: "and the docs", images: [later] };
    expect(unstarted({ prompt: "Fix the build", images: [image] }, since)).toMatchObject({ prompt: "Fix the build\nand the docs", images: [image, later], mode: "plan" });
    expect(unstarted({ prompt: "Fix the build", images: [] }, { ...since, prompt: "  ", images: [] })).toMatchObject({ prompt: "Fix the build", images: [] });
  });
});
