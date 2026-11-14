import { expect, it } from "vitest";
import { HOSTED_FILE_CHUNK_BYTES, hostedFilePath, hostedFileReference, hostedFilesRpcParams } from "./hosted-files.js";
import { rpcParams } from "./rpc.js";
import { isRemoteMethod } from "./remote.js";

const ref = {
  id: "77c80d84-e85b-4c87-8059-da77d0c1e15b",
  draftKey: "draft",
  scope: { accountId: "person", apiOrigin: "https://api.example.com", spaceId: "space", destination: { kind: "hosted", projectId: "project" } },
};

it("bounds each transfer chunk and keeps cloud upload controls out of the phone allowlist", () => {
  expect(rpcParams["hostedFiles.append"].safeParse({ ...ref, offset: 0, data: encodedZeros(HOSTED_FILE_CHUNK_BYTES) }).success).toBe(true);
  expect(rpcParams["hostedFiles.append"].safeParse({ ...ref, offset: 0, data: encodedZeros(HOSTED_FILE_CHUNK_BYTES + 1) }).success).toBe(false);
  expect(rpcParams["hostedFiles.append"].safeParse({ ...ref, offset: 0, data: "not base64" }).success).toBe(false);
  for (const method of Object.keys(hostedFilesRpcParams)) expect(isRemoteMethod(method)).toBe(false);
});

function encodedZeros(bytes: number): string {
  const remaining = bytes % 3;
  const complete = "AAAA".repeat(Math.floor(bytes / 3));
  if (remaining === 0) return complete;
  return complete + (remaining === 1 ? "AA==" : "AAA=");
}

it("accepts only a captured destination and file reference, never an arbitrary authenticated URL or disk path", () => {
  const asset = { scope: ref.scope, file: { id: "upload", name: "notes.txt" } };
  expect(rpcParams["hostedFiles.thumbnail"].safeParse(asset).success).toBe(true);
  expect(rpcParams["hostedFiles.thumbnail"].safeParse({ ...asset, url: "https://other.example.com/file" }).success).toBe(false);
  expect(rpcParams["hostedFiles.download"].safeParse({ ...asset, path: "/tmp/example" }).success).toBe(false);
});

it("reads the existing hosted file path without changing the submitted filename", () => {
  const file = { id: "upload", name: "notes %20 #1.txt" };
  expect(hostedFileReference(hostedFilePath(file))).toEqual(file);
  expect(hostedFileReference("https://api.example.com/hosted/files/upload/notes.txt")).toBeNull();
  expect(hostedFileReference("/tmp/notes.txt")).toBeNull();
  expect(hostedFileReference("/hosted/files/upload/")).toBeNull();
});
