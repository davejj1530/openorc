import type { hostedFilesRpcParams } from "@openorc/protocol";
import type { HostedFiles } from "../services/hosted-files.js";
import type { Handlers } from "./types.js";

export function createHostedFilesHandlers(files: HostedFiles): Pick<Handlers, keyof typeof hostedFilesRpcParams> {
  return {
    "hostedFiles.capture": ({ scope }) => files.capture(scope),
    "hostedFiles.availability": ({ scope }) => files.availability(scope),
    "hostedFiles.restore": (input) => files.restore(input),
    "hostedFiles.state": (input) => files.state(input),
    "hostedFiles.begin": (input) => files.begin(input),
    "hostedFiles.append": (input) => files.append(input),
    "hostedFiles.finish": (input) => files.finish(input),
    "hostedFiles.retry": (input) => files.retry(input),
    "hostedFiles.remove": (input) => files.remove(input),
    "hostedFiles.accepted": (input) => files.accepted(input),
    "hostedFiles.preview": (input) => files.preview(input),
    "hostedFiles.thumbnail": (input) => files.assets.thumbnail(input),
    "hostedFiles.download": (input) => files.assets.download(input),
  };
}
