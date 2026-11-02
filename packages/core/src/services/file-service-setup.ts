import { randomBytes } from "node:crypto";
import type { OpenOrcOptions } from "../options.js";
import type { EnvSnapshot } from "./shell-environment.js";
import type { WorkspaceWriters } from "./workspace-writers.js";
import { FileFormatter } from "./file-format.js";
import { FileService } from "./files.js";

/** The file panel's host-backed services, composed outside OpenOrc's lifecycle and routing module. */
export function createFileService({
  options,
  writers,
  invalidate,
  environment,
}: {
  options: Pick<OpenOrcOptions, "formatter" | "fileKey" | "intelligence">;
  writers: WorkspaceWriters;
  invalidate: (keys: string[]) => void;
  environment: () => EnvSnapshot;
}): FileService {
  return new FileService({
    writers,
    invalidate,
    formatter: new FileFormatter({ bundled: options.formatter ?? null, environment }),
    fileKey: options.fileKey ?? randomBytes(32).toString("hex"),
    intelligence: options.intelligence,
  });
}
