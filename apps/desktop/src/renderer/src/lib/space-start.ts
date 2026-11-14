import type { RpcParams, RpcResults } from "@openorc/protocol";
import { spaceNavigation } from "./space-navigation";

/** A completed start belongs to the captured space even if this window has since switched. */
export async function startSpaceThread(
  params: RpcParams<"threads.start">,
  launch: (params: RpcParams<"threads.start">) => Promise<RpcResults["threads.start"]>,
  spaceId: string | null,
  key: string | null,
) {
  const result = await launch({ ...params, ...(spaceId ? { spaceId } : {}) });
  if (spaceId) spaceNavigation.getState().observe(spaceId, [result.thread], key);
  return result;
}
