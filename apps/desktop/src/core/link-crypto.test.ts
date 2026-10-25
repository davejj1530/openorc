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

// Push alerts: the vectors the phone's extension opens, the ES256 token APNs checks, and one send over HTTP/2.
const pushScript = `
import { generateKeyPairSync, verify } from "node:crypto";
import http2 from "node:http2";
import { collapseId, fromBase64Url, openPush, pushKeys, sealPush } from "@openorc/link";
import { nodeCrypto as crypto } from "@openorc/link/node";
import vectors from "@openorc/link/test-fixtures/push-vectors.json";
import { ApnsRoute, apnsSigningKey, providerToken } from "@openorc/core/apns";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bytes = (a, b) => Buffer.from(a).equals(Buffer.from(b));

async function main() {
  const mac = crypto.keyPairFromPrivate(fromBase64Url(vectors.mac.privateKey));
  const phone = crypto.keyPairFromPrivate(fromBase64Url(vectors.phone.privateKey));
  const sealing = pushKeys(crypto, mac, phone.publicKey, "mac");
  const opening = pushKeys(crypto, phone, mac.publicKey, "phone");
  const fresh = { id: "fresh", kind: "finished", threadId: "thread", title: "Title", body: "Body" };

  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });
  const [head, claims, signature] = providerToken(apnsSigningKey(pem), "ABC123DEFG", "8VR6L6XPS9", Date.now()).split(".");
  const raw = Buffer.from(signature, "base64url");

  const heard = [];
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.on("data", (chunk) => (body += chunk));
    stream.on("end", () => {
      heard.push({ path: headers[":path"], topic: headers["apns-topic"], body });
      stream.respond({ ":status": 200 });
      stream.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const route = new ApnsRoute({ key: { keyId: "ABC123DEFG", teamId: "8VR6L6XPS9", pem }, topic: "app.openorc.mobile", origins: { sandbox: origin, production: origin } });
  const outcome = await route.send({ token: "ab".repeat(32), environment: "sandbox", collapseId: "thread", priority: 10, expiresAt: 1, payload: "{}" });
  route.close();
  server.close();

  console.log(JSON.stringify({
    keys: bytes(sealing.seal, fromBase64Url(vectors.keys.seal)) && bytes(opening.seal, sealing.seal) && bytes(sealing.collapse, fromBase64Url(vectors.keys.collapse)),
    resealed: vectors.good.every((vector) => same(sealPush(crypto, sealing.seal, mac.publicKey, vector.notice, fromBase64Url(vector.nonce)), vector.envelope)),
    opened: vectors.good.every((vector) => same(openPush(crypto, opening.seal, vector.envelope), vector.notice)),
    refused: vectors.bad.every((vector) => openPush(crypto, opening.seal, vector.envelope) === null),
    collapsed: vectors.collapseIds.every((entry) => collapseId(crypto, sealing.collapse, entry.threadId) === entry.id),
    roundTrip: same(openPush(crypto, opening.seal, sealPush(crypto, sealing.seal, mac.publicKey, fresh)), fresh),
    es256: raw.length === 64 && verify("sha256", Buffer.from(head + "." + claims), { key: publicKey, dsaEncoding: "ieee-p1363" }, raw),
    outcome,
    heard,
  }));
}
main();
`;

const folder = mkdtempSync(path.join(tmpdir(), "openorc-link-crypto-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

async function runInElectron(source: string, name: string): Promise<unknown> {
  const bundled = await build({ stdin: { contents: source, resolveDir: import.meta.dirname }, bundle: true, platform: "node", format: "cjs", write: false });
  const file = path.join(folder, name);
  writeFileSync(file, bundled.outputFiles[0]!.text);
  const electron = createRequire(import.meta.url)("electron") as unknown as string;
  const run = spawnSync(electron, [file], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 30_000 });
  expect(run.stderr).toBe("");
  return JSON.parse(run.stdout);
}

describe("phone link crypto on Electron's Node", () => {
  it("agrees on keys and seals and opens with the cipher the link uses", async () => {
    expect(await runInElectron(script, "link-crypto.cjs")).toEqual({ agreed: true, restored: true, opened: "ping", tamperedOpens: false });
  }, 60_000);

  it("seals push alerts to the vectors, signs APNs tokens as ES256 wants, and sends one over HTTP/2", async () => {
    expect(await runInElectron(pushScript, "push.cjs")).toEqual({
      keys: true,
      resealed: true,
      opened: true,
      refused: true,
      collapsed: true,
      roundTrip: true,
      es256: true,
      outcome: { kind: "sent" },
      heard: [{ path: `/3/device/${"ab".repeat(32)}`, topic: "app.openorc.mobile", body: "{}" }],
    });
  }, 60_000);
});
