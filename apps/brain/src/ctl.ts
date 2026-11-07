import { realpathSync } from "node:fs";
import path from "node:path";
import { brainLayout } from "@openorc/cloud";
import { askControl } from "./control.js";

const layout = brainLayout(path.resolve(realpathSync(import.meta.dirname), "..", ".."));
process.exitCode = await askControl(layout.socket, process.stdin, process.stdout);
