import { hkdfSync } from "node:crypto";
import type { BrainKey } from "@openorc/cloud";
import type { KeyPair } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";

/**
 * The Mac's static link key on its cloud brain, derived from the brain key. The brain derives the same public half from
 * the key it was started with and admits that key as its owner, without pairing; a brain set up again with a new key
 * forgets the old Mac at once. Whoever holds the brain key opens every secret on the brain already.
 */
export function ownerLinkKeys(key: BrainKey): KeyPair {
  return nodeCrypto.keyPairFromPrivate(new Uint8Array(hkdfSync("sha256", key, "openorc/brain", "owner-link/v1", 32)));
}
