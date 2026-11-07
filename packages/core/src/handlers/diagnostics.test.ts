import { expect, it } from "vitest";
import { rpcParams, secretParams, type RpcMethod } from "@openorc/protocol";
import type { z } from "zod";
import { rpcLogLine } from "./diagnostics.js";

/** A field name that holds a credential when its value is text. */
const SECRET_NAME = /token|apikey|secret|password|^pem$|^key$/i;

/** Every text field under a schema whose name reads as a credential, by its path. */
function secretFields(schema: z.ZodType, at = ""): string[] {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> & { type: string } } })._zod.def;
  switch (def.type) {
    case "object":
      return Object.entries(def["shape"] as Record<string, z.ZodType>).flatMap(([name, field]) => [
        ...(SECRET_NAME.test(name) && textual(field) ? [`${at}${name}`] : []),
        ...secretFields(field, `${at}${name}.`),
      ]);
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "nonoptional":
    case "catch":
      return secretFields(def["innerType"] as z.ZodType, at);
    case "pipe":
      return secretFields(def["in"] as z.ZodType, at);
    case "array":
      return secretFields(def["element"] as z.ZodType, at);
    case "union":
      return (def["options"] as z.ZodType[]).flatMap((option) => secretFields(option, at));
    default:
      return [];
  }
}

function textual(schema: z.ZodType): boolean {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> & { type: string } } })._zod.def;
  if (def.type === "string") return true;
  const inner = (def["innerType"] ?? def["in"]) as z.ZodType | undefined;
  return inner ? textual(inner) : false;
}

it("keeps out of the RPC log every method whose params carry a credential", () => {
  const carrying = (Object.entries(rpcParams) as [RpcMethod, z.ZodType][]).filter(([, schema]) => secretFields(schema).length > 0).map(([method]) => method);
  expect(carrying).toEqual(expect.arrayContaining(["cloud.vercel.connect", "cloud.claude.save", "cloud.codex.apiKey", "cloud.brain.codex.apiKey", "memory.settings.set", "remote.push.setKey"]));
  expect(carrying.filter((method) => !secretParams(method))).toEqual([]);
});

it("logs a sign-in's method and outcome but never its key", () => {
  const key = "sk-proj-0123456789abcdefghijklmnop";
  for (const [method, params] of [
    ["cloud.brain.codex.apiKey", { key }],
    ["cloud.codex.apiKey", { key }],
    ["cloud.vercel.connect", { token: key }],
    ["cloud.claude.save", { accountId: "work", token: key }],
  ] as const) {
    const line = rpcLogLine(method, params, null, 3);
    expect(line).toBe(`[rpc] ${method} [private] -> null in 3 ms`);
  }
  expect(rpcLogLine("threads.get", { id: "t1" }, null, 3)).toBe('[rpc] threads.get {"id":"t1"} -> null in 3 ms');
});
