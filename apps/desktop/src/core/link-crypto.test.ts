import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

// The core runs on Electron's Node, whose crypto is BoringSSL, not OpenSSL: a cipher plain Node has can be missing
// there. This runs the phone link's node crypto port inside the Electron binary the app ships with.
const script = `
import { nodeCrypto as crypto } from "@openorc/link/node";

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const mac = crypto.generateKeyPair();
const phone = crypto.generateKeyPair();
const shared = crypto.dh(phone.privateKey, mac.publicKey);
const key = crypto.hmacSha256(shared, crypto.sha256(new TextEncoder().encode("openorc")));
const nonce = new Uint8Array(12);
const ad = crypto.randomBytes(32);
const sealed = crypto.seal(key, nonce, ad, new TextEncoder().encode("ping"));
const opened = crypto.open(key, nonce, ad, sealed);
sealed[0] ^= 1;
console.log(JSON.stringify({
  agreed: hex(shared) === hex(crypto.dh(mac.privateKey, phone.publicKey)),
  restored: hex(crypto.keyPairFromPrivate(phone.privateKey).publicKey) === hex(phone.publicKey),
  opened: opened && new TextDecoder().decode(opened),
  tamperedOpens: crypto.open(key, nonce, ad, sealed) !== null,
}));
`;

const folder = mkdtempSync(path.join(tmpdir(), "openorc-link-crypto-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe("phone link crypto on Electron's Node", () => {
  it("agrees on keys and seals and opens with the cipher the link uses", async () => {
    const bundled = await build({ stdin: { contents: script, resolveDir: import.meta.dirname }, bundle: true, platform: "node", format: "cjs", write: false });
    const file = path.join(folder, "link-crypto.cjs");
    writeFileSync(file, bundled.outputFiles[0]!.text);
    const electron = createRequire(import.meta.url)("electron") as unknown as string;
    const run = spawnSync(electron, [file], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 30_000 });
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual({ agreed: true, restored: true, opened: "ping", tamperedOpens: false });
  }, 60_000);
});
