const fs = require("node:fs");
const { IOSConfig, withFinalizedMod } = require("expo/config-plugins");

const STRIP = "[Expo Dev Launcher] Strip Local Network Keys for Release";
const INFO_PLIST = '"$(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)"';

/**
 * expo-dev-launcher takes its Bonjour service out of Release builds with a script placed before the embed phases. With
 * an app extension embedded, Xcode writes the app's Info.plist only after embedding it (it scans the extension for a
 * privacy manifest), so on a clean build that script finds no Info.plist yet and the key ships. The script goes last
 * here and names the written Info.plist as its input, so it always runs on it. False when there is no such script.
 */
function stripAfterInfoPlist(project, projectName) {
  const { target } = IOSConfig.XcodeUtils.getApplicationNativeTarget({ project, projectName });
  const index = target.buildPhases.findIndex((phase) => phase.comment === STRIP);
  if (index === -1) return false;
  const [strip] = target.buildPhases.splice(index, 1);
  target.buildPhases.push(strip);
  project.hash.project.objects.PBXShellScriptBuildPhase[strip.value].inputPaths = [INFO_PLIST];
  return true;
}

/** Finalized, so it sees the phases every other plugin added, @bacons/apple-targets' embed phase among them. */
const withStripAfterInfoPlist = (config) =>
  withFinalizedMod(config, [
    "ios",
    async (config) => {
      const project = IOSConfig.XcodeUtils.getPbxproj(config.modRequest.projectRoot);
      if (stripAfterInfoPlist(project, config.modRequest.projectName)) fs.writeFileSync(project.filepath, project.writeSync());
      return config;
    },
  ]);

module.exports = withStripAfterInfoPlist;
module.exports.stripAfterInfoPlist = stripAfterInfoPlist;
