import { HOSTED_FILES_UNAVAILABLE, hostedFileReference } from "@openorc/protocol";
import { Refused, type Requests } from "./session.js";
import { PARITY_ROUTES } from "./wire-parity.js";

/** Only completed hosted references become file IDs; local draft handles never leave the app. */
export async function messageFileIds(on: Requests, paths: readonly string[] | undefined): Promise<string[]> {
  if (!paths?.length) return [];
  try {
    const capabilities = await on.request(PARITY_ROUTES.capabilities);
    const feature = capabilities.features.files;
    if (!feature?.available) throw new Refused(feature?.reason ?? HOSTED_FILES_UNAVAILABLE);
  } catch (error) {
    if (error instanceof Refused && error.status === 404) throw new Refused(HOSTED_FILES_UNAVAILABLE);
    throw error;
  }
  return paths.map((path) => {
    const file = hostedFileReference(path);
    if (!file) throw new Refused("This file isn't available in this space.");
    return file.id;
  });
}
