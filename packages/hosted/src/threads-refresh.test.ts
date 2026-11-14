import { afterEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { Spaces } from "./spaces.js";
import { Threads } from "./threads.js";
import { OutOfReach } from "./session.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

let stand: StandIn;
let hosted: Hosted;
afterEach(async () => {
  hosted?.close();
  await stand?.close();
  vi.restoreAllMocks();
});

async function waitingRead() {
  stand = await standIn({ signup: "open" });
  const { deps, browser, seen } = hostDeps(stand, newDevice());
  hosted = createHosted(deps);
  await hosted.start();
  await signInAs(hosted, browser, "reader@example.com");
  const { threads, spaces } = hosted;
  if (!(threads instanceof Threads) || !(spaces instanceof Spaces)) throw new Error("Expected the hosted services.");
  await threads.refresh();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  vi.spyOn(spaces, "catalog").mockImplementationOnce(async () => {
    entered();
    await held;
    throw new OutOfReach();
  });
  const reading = threads.refresh();
  await started;
  return { release, reading, seen, browser };
}

it.each(["sign out", "close", "another account"])("discards a pending catalog failure after %s", async (ending) => {
  const { release, reading, seen, browser } = await waitingRead();
  if (ending === "close") hosted.close();
  else {
    await hosted.account.signOut();
    if (ending === "another account") await signInAs(hosted, browser, "other@example.com");
  }
  // Only the already pending read fails; the next account has its own catalog.
  vi.restoreAllMocks();
  release();
  await reading;
  expect(seen.logs.filter((line) => line.startsWith("OpenOrc Cloud threads:"))).toEqual([]);
});

it("reports a failed catalog while its account and read are still current", async () => {
  const { release, reading, seen } = await waitingRead();
  release();
  await reading;
  expect(seen.logs.filter((line) => line.startsWith("OpenOrc Cloud threads:"))).toEqual(["OpenOrc Cloud threads: OpenOrc Cloud can't be reached."]);
});
