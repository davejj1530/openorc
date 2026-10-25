import { hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url, utf8 } from "./bytes.js";
import type { KeyPair, LinkCrypto } from "./crypto.js";
import { nodeCrypto } from "./node.js";
import { collapseId, openPush, pushKeys, sealPush, type PushEnvelope, type PushNotice } from "./push.js";
import { nobleCrypto } from "./test-fixtures/noble-crypto.js";
import vectorFile from "./test-fixtures/push-vectors.json" with { type: "json" };

const ports: Array<[string, LinkCrypto]> = [
  ["node:crypto", nodeCrypto],
  ["@noble", nobleCrypto],
];

const clip = (text: string, max: number) =>
  Array.from(text)
    .slice(0, max - 1)
    .join("") + "…";
const repeatTo = (unit: string, length: number) =>
  Array.from(unit.repeat(Math.ceil(length / Array.from(unit).length)))
    .slice(0, length)
    .join("");

/** What each good vector opens to, and what the Mac handed the sealer when that differs. */
const goodNotices: Array<{ name: string; notice: PushNotice; handed?: PushNotice }> = [
  {
    name: "approval with ids",
    notice: { id: "notice-1", kind: "approval", threadId: "thread-1", title: "Approve a command", body: "git push origin main", approval: { runId: "run-1", approvalId: "approval-1" } },
  },
  { name: "finished turn", notice: { id: "notice-2", kind: "finished", threadId: "thread-2", title: "Fix the login bug", body: "Done. The tests pass." } },
  { name: "test notice", notice: { id: "notice-3", kind: "test", threadId: null, title: "OpenOrc", body: "Notifications from Studio Mac reach this iPhone." } },
  {
    name: "emoji and quotes at the clip limits",
    notice: {
      id: "notice-4",
      kind: "question",
      threadId: "thread-4",
      title: clip(repeatTo('"Ship it" 🚀 \\ ', 200), 120),
      body: clip(repeatTo("👩🏽‍💻 said \"done\"\n\t'ok' \\ ", 800), 600),
    },
  },
  {
    // A reply cut by UTF-16 units through 🚀 leaves its first half alone, which Foundation's JSONDecoder refuses.
    name: "a lone surrogate where a cut split an emoji",
    handed: { id: "notice-5", kind: "finished", threadId: "thread-5", title: "Launch \ude80", body: `Shipped ${"🚀".slice(0, 1)}` },
    notice: { id: "notice-5", kind: "finished", threadId: "thread-5", title: "Launch \uFFFD", body: "Shipped \uFFFD" },
  },
];

const flipFirstByte = (text: string) => {
  const bytes = fromBase64Url(text);
  bytes[0]! ^= 1;
  return toBase64Url(bytes);
};

/** Fixed keys and nonces, so every byte of the output is a function of the scheme alone. */
function buildVectors(crypto: LinkCrypto) {
  const fixed = (label: string) => crypto.sha256(utf8(`openorc push vector: ${label}`));
  const mac = crypto.keyPairFromPrivate(fixed("mac"));
  const phone = crypto.keyPairFromPrivate(fixed("phone"));
  const otherMac = crypto.keyPairFromPrivate(fixed("other mac"));
  const keys = pushKeys(crypto, mac, phone.publicKey, "mac");
  const good = goodNotices.map(({ name, notice, handed }) => {
    const nonce = fixed(`nonce ${name}`).subarray(0, 12);
    return { name, nonce: toBase64Url(nonce), notice, envelope: sealPush(crypto, keys.seal, mac.publicKey, handed ?? notice, nonce) };
  });
  const approval = good[0]!.envelope;
  const bad: Array<{ name: string; envelope: PushEnvelope }> = [
    { name: "tampered ciphertext", envelope: { ...approval, c: flipFirstByte(approval.c) } },
    { name: "another Mac's m", envelope: { ...approval, m: toBase64Url(otherMac.publicKey) } },
    { name: "flipped nonce", envelope: { ...approval, n: flipFirstByte(approval.n) } },
    { name: "unknown version", envelope: { ...approval, v: 2 } },
  ];
  const pair = (keyPair: KeyPair) => ({ privateKey: toBase64Url(keyPair.privateKey), publicKey: toBase64Url(keyPair.publicKey) });
  return {
    mac: pair(mac),
    phone: pair(phone),
    otherMac: pair(otherMac),
    keys: { seal: toBase64Url(keys.seal), collapse: toBase64Url(keys.collapse) },
    collapseIds: ["thread-1", "thread-2", null].map((threadId) => ({ threadId, id: collapseId(crypto, keys.collapse, threadId) })),
    good,
    bad,
  };
}

const vectorKeys = (crypto: LinkCrypto) => {
  const mac = crypto.keyPairFromPrivate(fromBase64Url(vectorFile.mac.privateKey));
  const phone = crypto.keyPairFromPrivate(fromBase64Url(vectorFile.phone.privateKey));
  return { mac, phone, seal: pushKeys(crypto, phone, mac.publicKey, "phone").seal };
};

describe("push vectors", () => {
  it("are what the node port seals with fixed keys and nonces", async () => {
    await expect(`${JSON.stringify(buildVectors(nodeCrypto), null, 2)}\n`).toMatchFileSnapshot("./test-fixtures/push-vectors.json");
  });

  it("are reproduced byte for byte by the noble port", () => {
    expect(buildVectors(nobleCrypto)).toEqual(buildVectors(nodeCrypto));
  });

  it.each(ports)("open to their notices with the %s port, and every bad case is refused", (_name, crypto) => {
    const { seal } = vectorKeys(crypto);
    for (const vector of vectorFile.good) expect(openPush(crypto, seal, vector.envelope)).toEqual(vector.notice);
    for (const vector of vectorFile.bad) expect(openPush(crypto, seal, vector.envelope), vector.name).toBeNull();
  });
});

describe.each([
  ["node", "noble", nodeCrypto, nobleCrypto],
  ["noble", "node", nobleCrypto, nodeCrypto],
] as const)("a %s Mac and a %s phone", (_mac, _phone, macCrypto, phoneCrypto) => {
  const mac = macCrypto.generateKeyPair();
  const phone = phoneCrypto.generateKeyPair();
  const macKeys = pushKeys(macCrypto, mac, phone.publicKey, "mac");
  const phoneKeys = pushKeys(phoneCrypto, phone, mac.publicKey, "phone");

  it("derive the same keys from their static pairs alone", () => {
    expect(phoneKeys).toEqual(macKeys);
    expect(macKeys.seal).toHaveLength(32);
    expect(macKeys.collapse).toHaveLength(32);
    expect(macKeys.seal).not.toEqual(macKeys.collapse);
  });

  it("seal with a random nonce that the phone opens", () => {
    const notice = goodNotices[0]!.notice;
    const first = sealPush(macCrypto, macKeys.seal, mac.publicKey, notice);
    const second = sealPush(macCrypto, macKeys.seal, mac.publicKey, notice);
    expect(first.n).not.toBe(second.n);
    expect(fromBase64Url(first.n)).toHaveLength(12);
    expect(first.m).toBe(toBase64Url(mac.publicKey));
    expect(openPush(phoneCrypto, phoneKeys.seal, first)).toEqual(notice);
    expect(openPush(phoneCrypto, phoneKeys.seal, second)).toEqual(notice);
  });

  it("seal half an emoji as U+FFFD, in any field, so no reader meets a lone surrogate", () => {
    const half = "🚀".slice(0, 1);
    const notice: PushNotice = {
      id: `id ${half}`,
      kind: "approval",
      threadId: `thread ${half}`,
      title: `${half}Launch`,
      body: `Shipped ${half}`,
      approval: { runId: half, approvalId: "🚀".slice(1) },
    };
    expect(openPush(phoneCrypto, phoneKeys.seal, sealPush(macCrypto, macKeys.seal, mac.publicKey, notice))).toEqual({
      id: "id �",
      kind: "approval",
      threadId: "thread �",
      title: "�Launch",
      body: "Shipped �",
      approval: { runId: "�", approvalId: "�" },
    });
  });
});

describe("openPush", () => {
  const crypto = nodeCrypto;
  const { mac, seal } = vectorKeys(crypto);
  const envelope = vectorFile.good[0]!.envelope;
  const sealRaw = (plaintext: Uint8Array) => {
    const nonce = crypto.randomBytes(12);
    return { v: 1, m: envelope.m, n: toBase64Url(nonce), c: toBase64Url(crypto.seal(seal, nonce, utf8(`openorc push v1.${envelope.m}`), plaintext)) };
  };

  it("refuses any changed byte of the nonce, the ciphertext or the tag", () => {
    for (const field of ["n", "c"] as const) {
      const bytes = fromBase64Url(envelope[field]);
      for (let index = 0; index < bytes.length; index++) {
        const changed = Uint8Array.from(bytes);
        changed[index]! ^= 0x80;
        expect(openPush(crypto, seal, { ...envelope, [field]: toBase64Url(changed) }), `${field}[${index}]`).toBeNull();
      }
    }
  });

  it("refuses another seal key, a truncated or malformed envelope, and a nonce of the wrong length", () => {
    const sealed = fromBase64Url(envelope.c);
    expect(openPush(crypto, crypto.randomBytes(32), envelope)).toBeNull();
    expect(openPush(crypto, seal, { ...envelope, c: toBase64Url(sealed.subarray(0, 16)) })).toBeNull();
    expect(openPush(crypto, seal, { ...envelope, c: toBase64Url(sealed.subarray(0, sealed.length - 1)) })).toBeNull();
    expect(openPush(crypto, seal, { ...envelope, c: `${envelope.c}=` })).toBeNull();
    expect(openPush(crypto, seal, { ...envelope, n: toBase64Url(fromBase64Url(envelope.n).subarray(0, 11)) })).toBeNull();
    expect(openPush(crypto, seal, { ...envelope, m: toBase64Url(mac.publicKey).slice(1) })).toBeNull();
  });

  it("refuses an authentic plaintext that is not a notice", () => {
    const notice = goodNotices[1]!.notice;
    expect(openPush(crypto, seal, sealRaw(utf8(JSON.stringify(notice))))).toEqual(notice);
    const notNotices = [
      "not json",
      JSON.stringify([notice]),
      JSON.stringify({ ...notice, kind: "comment" }),
      JSON.stringify({ ...notice, threadId: 7 }),
      JSON.stringify({ ...notice, extra: true }),
      JSON.stringify({ ...notice, approval: { runId: "run-1" } }),
      JSON.stringify({ id: notice.id, kind: notice.kind, threadId: notice.threadId, title: notice.title }),
    ];
    for (const text of notNotices) expect(openPush(crypto, seal, sealRaw(utf8(text))), text).toBeNull();
    expect(openPush(crypto, seal, sealRaw(Uint8Array.of(0x7b, 0xff, 0x7d)))).toBeNull();
  });
});

describe("collapseId", () => {
  const crypto = nodeCrypto;
  const mac = crypto.generateKeyPair();
  const collapseFor = (phone: KeyPair) => pushKeys(crypto, mac, phone.publicKey, "mac").collapse;
  const phone = collapseFor(crypto.generateKeyPair());
  const otherPhone = collapseFor(crypto.generateKeyPair());

  it("is 22 opaque characters, the same per thread and phone, and different across threads and phones", () => {
    const id = collapseId(crypto, phone, "thread-1");
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(collapseId(crypto, phone, "thread-1")).toBe(id);
    expect(collapseId(crypto, phone, "thread-2")).not.toBe(id);
    expect(collapseId(crypto, otherPhone, "thread-1")).not.toBe(id);
    expect(collapseId(crypto, phone, null)).not.toBe(id);
    expect(collapseId(crypto, phone, "test")).not.toBe(collapseId(crypto, phone, null));
  });

  it("agrees across ports with the vectors", () => {
    for (const [, port] of ports) {
      const collapse = fromBase64Url(vectorFile.keys.collapse);
      for (const vector of vectorFile.collapseIds) expect(collapseId(port, collapse, vector.threadId)).toBe(vector.id);
    }
  });
});

describe("pushKeys", () => {
  it("is RFC 5869 HKDF-SHA256, as node's own hkdfSync computes it", () => {
    const { mac, phone } = vectorKeys(nodeCrypto);
    const secret = nodeCrypto.dh(mac.privateKey, phone.publicKey);
    const expected = (purpose: string) => new Uint8Array(hkdfSync("sha256", secret, "openorc push v1", Buffer.concat([utf8(purpose), mac.publicKey, phone.publicKey]), 32));
    expect(pushKeys(nodeCrypto, mac, phone.publicKey, "mac")).toEqual({ seal: expected("seal"), collapse: expected("collapse") });
  });

  it("refuses an all-zero shared secret, even from a port that returns one", () => {
    const zeros: LinkCrypto = { ...nodeCrypto, dh: () => new Uint8Array(32) };
    for (const crypto of [zeros, nodeCrypto, nobleCrypto]) expect(() => pushKeys(crypto, crypto.generateKeyPair(), new Uint8Array(32), "mac")).toThrow();
  });
});
