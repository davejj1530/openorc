const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

// Expo detects the pnpm workspace: it watches the repository and resolves from the app's and the root's node_modules.
const config = getDefaultConfig(__dirname);
const workspacePackages = path.resolve(__dirname, "../../packages") + path.sep;
const appEntry = path.join(__dirname, "index.ts");
// One copy of each, whichever package asks for it: two Reacts in one bundle break hooks.
const singletons = new Set(["react", "react-native"]);

const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = resolveRequest ?? context.resolveRequest;
  const origin = context.originModulePath;
  // Workspace packages are TypeScript sources written with ESM ".js" specifiers.
  if (moduleName.startsWith(".") && moduleName.endsWith(".js") && origin.startsWith(workspacePackages) && !origin.includes(`${path.sep}node_modules${path.sep}`)) {
    return resolve(context, moduleName.slice(0, -".js".length), platform);
  }
  const packageName = moduleName.startsWith("@") ? moduleName.split("/", 2).join("/") : moduleName.split("/", 1)[0];
  if (singletons.has(packageName)) return resolve({ ...context, originModulePath: appEntry }, moduleName, platform);
  return resolve(context, moduleName, platform);
};

// Uniwind rewrites its typings in its own style on every start, so they land out of the tree; src/uniwind.d.ts is the
// committed copy TypeScript reads.
module.exports = withUniwindConfig(config, { cssEntryFile: "./src/global.css", dtsFile: "./node_modules/uniwind-types.d.ts" });
