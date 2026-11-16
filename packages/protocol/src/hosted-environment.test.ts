import { expect, it } from "vitest";
import { hostedEnvironmentRpcParams } from "./hosted-environment.js";
import { isRemoteMethod } from "./remote.js";
import { rpcParams } from "./rpc.js";

it("keeps a project's environment off the phone and bounds what one save carries", () => {
  for (const method of Object.keys(hostedEnvironmentRpcParams)) expect(isRemoteMethod(method)).toBe(false);
  const save = (variables: unknown) => rpcParams["hostedEnvironment.set"].safeParse({ spaceId: "space", projectId: "project", variables }).success;
  expect(save([{ name: "DATABASE_URL", value: "postgres://localhost/app" }])).toBe(true);
  expect(save([])).toBe(false);
  expect(save([{ name: "BIG", value: "x".repeat(32 * 1024 + 1) }])).toBe(false);
  expect(save(Array.from({ length: 201 }, (_, i) => ({ name: `V${i}`, value: "x" })))).toBe(false);
  expect(rpcParams["hostedEnvironment.fromFile"].safeParse({ localProjectId: "p", path: "/etc" }).success).toBe(false);
});
