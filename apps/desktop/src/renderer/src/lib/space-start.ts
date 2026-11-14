import type { RpcParams, RpcResults } from "@openorc/protocol";
import { spaceNavigation } from "./space-navigation";

/** A completed start belongs to the captured space even if this window has since switched. */
export async function startSpaceThread(
  params: RpcParams<"threads.start">,
  launch: (params: RpcParams<"threads.start">) => Promise<RpcResults["threads.start"]>,
  spaceId: string | null,
  key: string | null,
) {
  const detached = spaceNavigation
    .getState()
    .inventory.find((space) => space.id === spaceId)
    ?.detached?.projects.some((project) => project.key === params.projectId);
  if (detached && (params.cloud || params.hosted)) throw new Error("This project isn't available in this space.");
  const result = await launch({ ...params, ...(spaceId && !detached ? { spaceId } : {}) });
  if (spaceId) spaceNavigation.getState().observe(spaceId, [result.thread], key);
  return result;
}
