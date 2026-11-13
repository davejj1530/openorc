import { describe, expect, it } from "vitest";
import { createAppearancePreviewRpc } from "./appearance-preview-data";

describe("appearance preview data", () => {
  it("keeps the shell's appearance handover from changing the example settings", async () => {
    const call = createAppearancePreviewRpc();
    const before = await call("app.settings.get", {});
    await call("app.settings.set", { defaultHarness: "claude", notifications: true });
    expect(await call("app.settings.get", {})).toEqual(before);
  });

  it("refuses project actions and keeps the example project intact", async () => {
    const call = createAppearancePreviewRpc();
    const projects = await call("projects.list", {});
    await expect(call("projects.remove", { id: projects[0]!.id })).rejects.toThrow("Unavailable in the appearance preview");
    expect(await call("projects.list", {})).toEqual(projects);
  });
});
