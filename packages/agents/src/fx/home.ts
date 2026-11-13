import os from "node:os";
import path from "node:path";

export const fxHome = (env: NodeJS.ProcessEnv, home = env["HOME"] || os.homedir()): string => env["FX_HOME"] || path.join(home, ".fx");
