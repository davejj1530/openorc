import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADA = "ada@example.com";
const BEN = "ben@example.com";
const SECRET = "Bearer person-secret-a1b2";
const URL_ = "https://mcp.tools-example.com/mcp";

let stand: StandIn;
const hosts: Hosted[] = [];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
});

afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

async function signedIn(email: string) {
  const { deps, browser } = hostDeps(stand, newDevice());
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, email);
  return hosted;
}

describe("a person's cloud connectors", () => {
  it("reads as unavailable behind the server's switch", async () => {
    const ada = await signedIn(ADA);
    stand.threadFiles.capabilities = { httpsConnectors: { available: false, reason: "Your connectors aren't available in cloud threads yet." } };
    expect(await ada.connectors.read()).toEqual({ state: "unavailable" });
  });

  it("saves one for several agents, checks it once, keeps a value by name, drops an agent, and never reads a value back", async () => {
    stand.threadFiles.capabilities = { httpsConnectors: { available: true } };
    const ada = await signedIn(ADA);
    const saved = await ada.connectors.save({ name: "tracker", url: URL_, headers: [{ name: "Authorization", value: SECRET }], agents: ["claude", "codex"] });
    expect(saved).toMatchObject({
      state: "ready",
      connectors: [
        { agent: "claude", name: "tracker", url: URL_, headers: [{ name: "authorization" }], check: { status: "connected", message: null } },
        { agent: "codex", name: "tracker", check: null },
      ],
    });
    expect(JSON.stringify(saved)).not.toContain("person-secret");
    expect(stand.connectors.saved(ADA, "codex", "tracker", "authorization")).toBe(SECRET);
    // Ben has none of Ada's.
    expect(await (await signedIn(BEN)).connectors.read()).toEqual({ state: "ready", connectors: [] });

    // Kept by name, and Codex left out: it leaves Codex.
    stand.connectors.answers.set(URL_, { status: "refused", message: "The connector refused these headers." });
    const again = await ada.connectors.save({ name: "tracker", url: URL_, headers: [{ name: "authorization", keep: true }], agents: ["claude"] });
    expect(again).toMatchObject({ state: "ready", connectors: [{ agent: "claude", revision: 2, check: { status: "refused", message: "The connector refused these headers." } }] });
    expect(stand.connectors.saved(ADA, "claude", "tracker", "authorization")).toBe(SECRET);

    expect(await ada.connectors.remove("tracker")).toEqual({ state: "ready", connectors: [] });
  });
});
