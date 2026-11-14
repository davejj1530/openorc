import { afterEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

let stand: StandIn | undefined;
let hosted: Hosted | undefined;
afterEach(async () => {
  hosted?.close();
  await stand?.close();
});

it("filters a delayed admin roster against current membership before exposing private seat facts", async () => {
  const server = (stand = await standIn({ signup: "open" }));
  const spaceId = server.addTeam("Example team", ["admin@example.com", "member@example.com"]);
  server.organizations.seat = () => ({ id: "private-seat", paysForPro: true });
  let release = () => {},
    held = false;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { deps, browser } = hostDeps(server, newDevice(), {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(String(input)).pathname === "/organization/people") {
        held = true;
        await wait;
      }
      return response;
    },
  });
  const client = (hosted = createHosted(deps));
  await client.start();
  await signInAs(client, browser, "admin@example.com");
  await vi.waitFor(() => expect(client.spaces.status().state).toBe("ready"));
  const reading = client.spaces.people(spaceId);
  await vi.waitFor(() => expect(held).toBe(true));
  server.spaces.member(spaceId, "admin@example.com")!.role = "member";
  await client.spaces.refresh();
  release();
  const result = await reading;
  expect(result.members.find((member) => member.email === "member@example.com")?.seat).toBeNull();
  expect(result.members.find((member) => member.email === "admin@example.com")?.seat).toEqual({ id: "private-seat", paysForPro: true });
});
