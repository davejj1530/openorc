import { describe, expect, it } from "vitest";
import type { LinkCrypto } from "./crypto.js";
import { nodeCrypto } from "./node.js";
import { initiate, respond, type NoiseTransport } from "./noise.js";
import { nobleCrypto } from "./test-fixtures/noble-crypto.js";
import vectorFile from "./test-fixtures/noise-ik-vectors.json" with { type: "json" };

const hex = (text: string) => Uint8Array.from(Buffer.from(text, "hex"));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const ports: Array<[string, LinkCrypto]> = [
  ["node:crypto", nodeCrypto],
  ["@noble", nobleCrypto],
];

describe.each(ports)("Noise IK with the %s port", (_name, crypto) => {
  it.each(vectorFile.vectors)("reproduces the cacophony vector for $protocol_name", (vector) => {
    const pair = (privateKey: string) => crypto.keyPairFromPrivate(hex(privateKey));
    const responderStatic = pair(vector.resp_static);
    expect(toHex(responderStatic.publicKey)).toBe(vector.init_remote_static);
    const [first, second, ...transportMessages] = vector.messages;
    const initiator = initiate({
      crypto,
      prologue: hex(vector.init_prologue),
      local: pair(vector.init_static),
      ephemeral: pair(vector.init_ephemeral),
      remoteStatic: hex(vector.init_remote_static),
      payload: hex(first!.payload),
    });
    expect(toHex(initiator.message)).toBe(first!.ciphertext);

    const responder = respond({ crypto, prologue: hex(vector.resp_prologue), local: responderStatic, ephemeral: pair(vector.resp_ephemeral), message: initiator.message });
    expect(toHex(responder.remoteStatic)).toBe(toHex(pair(vector.init_static).publicKey));
    expect(toHex(responder.payload)).toBe(first!.payload);
    const reply = responder.reply(hex(second!.payload));
    expect(toHex(reply.message)).toBe(second!.ciphertext);

    const finished = initiator.finish(reply.message);
    expect(toHex(finished.payload)).toBe(second!.payload);
    expect(toHex(finished.transport.handshakeHash)).toBe(vector.handshake_hash);
    expect(toHex(reply.transport.handshakeHash)).toBe(vector.handshake_hash);

    // After the handshake the vector alternates initiator and responder, starting with the initiator.
    transportMessages.forEach((message, index) => {
      const [sender, receiver]: [NoiseTransport, NoiseTransport] = index % 2 === 0 ? [finished.transport, reply.transport] : [reply.transport, finished.transport];
      const sealed = sender.send.seal(new Uint8Array(0), hex(message.payload));
      expect(toHex(sealed)).toBe(message.ciphertext);
      expect(toHex(receiver.receive.open(new Uint8Array(0), sealed)!)).toBe(message.payload);
    });
  });
});

describe("crypto ports", () => {
  it.each([
    ["node", "noble", nodeCrypto, nobleCrypto],
    ["noble", "node", nobleCrypto, nodeCrypto],
  ] as const)("complete a handshake and exchange messages between a %s initiator and a %s responder", (_a, _b, phone, mac) => {
    const prologue = new TextEncoder().encode("openorc-link/1");
    const macKey = mac.generateKeyPair();
    const deviceKey = phone.generateKeyPair();
    const initiator = initiate({ crypto: phone, prologue, local: deviceKey, remoteStatic: macKey.publicKey, payload: new TextEncoder().encode("hello mac") });
    const responder = respond({ crypto: mac, prologue, local: macKey, message: initiator.message });
    expect(responder.remoteStatic).toEqual(deviceKey.publicKey);
    const reply = responder.reply(new TextEncoder().encode("hello phone"));
    const finished = initiator.finish(reply.message);
    expect(new TextDecoder().decode(finished.payload)).toBe("hello phone");
    const record = finished.transport.send.seal(new Uint8Array(0), new TextEncoder().encode("first record"));
    expect(new TextDecoder().decode(reply.transport.receive.open(new Uint8Array(0), record)!)).toBe("first record");
    const answer = reply.transport.send.seal(new Uint8Array(0), new TextEncoder().encode("answer"));
    expect(new TextDecoder().decode(finished.transport.receive.open(new Uint8Array(0), answer)!)).toBe("answer");
  });

  it("agree on X25519, AES-256-GCM, SHA-256 and HMAC output", () => {
    const alice = nodeCrypto.generateKeyPair();
    const bob = nobleCrypto.generateKeyPair();
    expect(nodeCrypto.dh(alice.privateKey, bob.publicKey)).toEqual(nobleCrypto.dh(bob.privateKey, alice.publicKey));
    expect(nodeCrypto.keyPairFromPrivate(bob.privateKey).publicKey).toEqual(bob.publicKey);
    const key = nodeCrypto.randomBytes(32);
    const nonce = nodeCrypto.randomBytes(12);
    const ad = nodeCrypto.randomBytes(7);
    const plaintext = nodeCrypto.randomBytes(1000);
    const sealed = nodeCrypto.seal(key, nonce, ad, plaintext);
    expect(sealed).toEqual(nobleCrypto.seal(key, nonce, ad, plaintext));
    expect(nobleCrypto.open(key, nonce, ad, sealed)).toEqual(plaintext);
    sealed[3]! ^= 1;
    expect(nodeCrypto.open(key, nonce, ad, sealed)).toBeNull();
    expect(nobleCrypto.open(key, nonce, ad, sealed)).toBeNull();
    expect(nodeCrypto.sha256(plaintext)).toEqual(nobleCrypto.sha256(plaintext));
    expect(nodeCrypto.hmacSha256(key, plaintext)).toEqual(nobleCrypto.hmacSha256(key, plaintext));
  });

  it("refuses a handshake meant for another Mac", () => {
    const prologue = new Uint8Array(0);
    const initiator = initiate({ crypto: nodeCrypto, prologue, local: nodeCrypto.generateKeyPair(), remoteStatic: nodeCrypto.generateKeyPair().publicKey, payload: new Uint8Array(0) });
    expect(() => respond({ crypto: nodeCrypto, prologue, local: nodeCrypto.generateKeyPair(), message: initiator.message })).toThrow("did not authenticate");
  });
});
