import * as crypto from "node:crypto";
import { createNodeStyleCrypto } from "./node-style.js";

// Node reads a DER key from any byte view; its typings ask for a Buffer.
export const nodeCrypto = createNodeStyleCrypto({
  ...crypto,
  createPrivateKey: (input) => crypto.createPrivateKey({ ...input, key: Buffer.from(input.key) }),
  createPublicKey: (input) => crypto.createPublicKey("key" in input ? { ...input, key: Buffer.from(input.key) } : input),
});
