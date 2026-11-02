import { realpathSync } from "node:fs";
import { BRAIN_EXIT } from "@openorc/cloud";
import { serve } from "./host.js";

if (process.argv[2] !== "serve") {
  process.stderr.write("Usage: node brain.mjs serve, with the start line on stdin.\n");
  process.exit(BRAIN_EXIT.badStart);
}
// The real folder, not app/current's: a version keeps running from its own folder when `current` moves on.
await serve(realpathSync(import.meta.dirname));
