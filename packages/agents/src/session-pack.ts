import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { sessionId, type PackedSession } from "./session-slot.js";
import { sessionSlots } from "./session-slots.js";

/*
 * A session slot's export as the bytes OpenOrc Cloud keeps (its server's `packSession`, byte for byte): a first line
 * of JSON naming the agent, the slot's format, the session, the CLI version, `meta`, and each part's name, size and
 * SHA-256 in the slot's own order, then the parts' bytes end to end, all gzipped. A thread moving between this Mac and
 * the cloud carries its agent's conversation this way, in either direction.
 */

/** The first line of a packed session: what wrote it, and each part's name, size and SHA-256 in the slot's own order. */
type PackHeader = Omit<PackedSession, "parts"> & { parts: { name: string; bytes: number; sha256: string }[] };

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function packSession(saved: PackedSession): Buffer {
  const header: PackHeader = {
    agent: saved.agent,
    format: saved.format,
    cliVersion: saved.cliVersion,
    sessionId: saved.sessionId,
    meta: saved.meta,
    parts: saved.parts.map((part) => ({ name: part.name, bytes: part.bytes.length, sha256: sha256(part.bytes) })),
  };
  return gzipSync(Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), ...saved.parts.map((part) => part.bytes)]));
}

/**
 * The reverse. Throws when the bytes do not gunzip, the first line is not the shape above, or a part's size or SHA-256
 * is not what the line says, so a slot's `import` is only ever handed a session that is whole.
 */
export function unpackSession(bytes: Buffer): PackedSession {
  const all = gunzipSync(bytes);
  const end = all.indexOf(0x0a);
  if (end < 0) throw new Error("The saved conversation has no first line.");
  const header = parseHeader(JSON.parse(all.subarray(0, end).toString("utf8")) as unknown);
  let at = end + 1;
  const parts = header.parts.map((part) => {
    const body = all.subarray(at, at + part.bytes);
    at += part.bytes;
    if (body.length !== part.bytes || sha256(body) !== part.sha256) throw new Error(`The saved conversation's part ${part.name} is not the bytes it names.`);
    return { name: part.name, bytes: Buffer.from(body) };
  });
  if (at !== all.length) throw new Error("The saved conversation holds more than its parts.");
  return { ...header, parts };
}

function parseHeader(value: unknown): PackHeader {
  const header = value as Partial<PackHeader> | null;
  const id = sessionId(header?.sessionId);
  const plain = (meta: unknown) => meta !== null && typeof meta === "object" && Object.values(meta).every((entry) => entry === null || ["string", "number", "boolean"].includes(typeof entry));
  const partOk = (part: unknown) => {
    const { name, bytes, sha256: hash } = (part ?? {}) as Partial<PackHeader["parts"][number]>;
    return typeof name === "string" && Number.isSafeInteger(bytes) && bytes! >= 0 && typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash);
  };
  if (
    !header ||
    typeof header.agent !== "string" ||
    !(header.agent in sessionSlots) ||
    !Number.isSafeInteger(header.format) ||
    typeof header.cliVersion !== "string" ||
    !id ||
    !plain(header.meta) ||
    !Array.isArray(header.parts) ||
    !header.parts.every(partOk)
  )
    throw new Error("The saved conversation's first line is not one OpenOrc reads.");
  return { agent: header.agent, format: header.format!, cliVersion: header.cliVersion, sessionId: id, meta: header.meta!, parts: header.parts };
}
