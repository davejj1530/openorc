import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

/* The models OpenOrc Cloud runs for the person: its server's answer, and none from a server from before the catalog. */
const email = "reader@example.com";
let stand: StandIn;
let hosted: Hosted;
let status: number;
let asked: number;

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  status = 200;
  asked = 0;
  const host = hostDeps(stand, newDevice(), {
    fetch: async (input, init) => {
      if (new URL(String(input)).pathname !== "/hosted/models") return fetch(input, init);
      asked += 1;
      return status === 404
        ? Response.json({ statusCode: 404, message: "Cannot GET /hosted/models" }, { status })
        : Response.json({ agents: [{ agent: "codex", cliVersion: "0.80.0", readAt: "2026-11-18T02:00:00.000Z", listing: [] }] });
    },
  });
  hosted = createHosted(host.deps);
  await hosted.start();
  await signInAs(hosted, host.browser, email);
});
afterEach(async () => {
  hosted.close();
  await stand.close();
});

it("reads the person's cloud catalog, and from a server without one answers none, asking it once a session", async () => {
  expect(await hosted.models.read()).toEqual({ agents: [{ agent: "codex", cliVersion: "0.80.0", readAt: "2026-11-18T02:00:00.000Z", listing: [] }] });
  status = 404;
  expect(await hosted.models.read()).toBeNull();
  expect(await hosted.models.read()).toBeNull();
  expect(asked).toBe(2);
  await vi.waitFor(() => expect(hosted.account.status().state).toBe("signed-in"));
});
