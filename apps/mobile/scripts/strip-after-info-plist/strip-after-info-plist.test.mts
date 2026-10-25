import { IOSConfig } from "expo/config-plugins";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import app from "../../app.json" with { type: "json" };

const require = createRequire(import.meta.url);
const plugin = "./plugins/strip-after-info-plist";
const { stripAfterInfoPlist } = require(resolve(import.meta.dirname, "../..", plugin)) as { stripAfterInfoPlist: (project: unknown, projectName: string) => boolean };
const STRIP = "[Expo Dev Launcher] Strip Local Network Keys for Release";

/** The app target's phases as prebuild leaves them with the extension embedded: the strip before the embed phases. */
function prebuilt() {
  const root = mkdtempSync(join(tmpdir(), "openorc-strip-"));
  mkdirSync(join(root, "ios/OpenOrc.xcodeproj"), { recursive: true });
  copyFileSync(resolve(import.meta.dirname, "project.pbxproj"), join(root, "ios/OpenOrc.xcodeproj/project.pbxproj"));
  const project = IOSConfig.XcodeUtils.getPbxproj(root);
  rmSync(root, { recursive: true, force: true });
  return project;
}

it("runs the dev launcher's Release strip last, on the Info.plist Xcode wrote, so its Bonjour key never ships", () => {
  const project = prebuilt();
  expect(stripAfterInfoPlist(project, "OpenOrc")).toBe(true);
  const { target } = IOSConfig.XcodeUtils.getApplicationNativeTarget({ project, projectName: "OpenOrc" });
  const phases = (target.buildPhases as { comment: string; value: string }[]).map((phase) => phase.comment);
  expect(phases).toEqual(["Resources", "Embed Foundation Extensions", "[CP] Embed Pods Frameworks", STRIP]);
  const strip = (target.buildPhases as { comment: string; value: string }[]).at(-1)!;
  expect(project.hash.project.objects.PBXShellScriptBuildPhase[strip.value].inputPaths).toEqual(['"$(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)"']);
});

it("leaves a project without the strip as it is", () => {
  const project = prebuilt();
  const { target } = IOSConfig.XcodeUtils.getApplicationNativeTarget({ project, projectName: "OpenOrc" });
  target.buildPhases = (target.buildPhases as { comment: string }[]).filter((phase) => phase.comment !== STRIP);
  const before = project.writeSync();
  expect(stripAfterInfoPlist(project, "OpenOrc")).toBe(false);
  expect(project.writeSync()).toBe(before);
});

it("is one of the app's plugins", () => {
  expect((app.expo as { plugins: unknown[] }).plugins).toContain(plugin);
});
