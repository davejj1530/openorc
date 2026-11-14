import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { Session, Unreadable } from "./session.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

let stand: StandIn;
let host: Hosted;
let session: Session;
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
});
afterEach(async () => {
  vi.useRealTimers();
  session?.close();
  host?.close();
  await stand.close();
});

async function start(read: typeof fetch) {
  const device = newDevice();
  const { deps, browser } = hostDeps(stand, device);
  host = createHosted(deps);
  await host.start();
  await signInAs(host, browser, "reader@example.com");
  session = new Session({ ...deps, fetch: read });
  await session.start();
}

it("keeps binary reads on the account origin, names their space and refuses redirects", async () => {
  const read = vi.fn<typeof fetch>(async (_url, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toMatch(/^Bearer /);
    expect(headers.get("x-openorc-space")).toBe("personal-reader@example.com");
    expect(init?.redirect).toBe("error");
    return new Response("Exact bytes");
  });
  await start(read);
  const signal = new AbortController().signal;
  const response = await session.stream("personal-reader@example.com", "/hosted/files/id/name", signal);
  expect(await response.text()).toBe("Exact bytes");
  for (const path of ["https://another.example.test/private", "//another.example.test/private", "/\\another.example.test/private"])
    await expect(session.stream("personal-reader@example.com", path, signal)).rejects.toBeInstanceOf(Unreadable);
  expect(read).toHaveBeenCalledTimes(1);
});

it("retains scalar and array refusal words on a binary read", async () => {
  const read = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ message: "That file isn't here." }, { status: 404 }))
    .mockResolvedValueOnce(Response.json({ message: ["download: Invalid option", "Not shown"] }, { status: 400 }));
  await start(read);
  const signal = new AbortController().signal;
  await expect(session.stream("personal-reader@example.com", "/hosted/files/id/name", signal)).rejects.toThrow("That file isn't here.");
  await expect(session.stream("personal-reader@example.com", "/hosted/files/id/name", signal)).rejects.toThrow("download: Invalid option");
});

it("ends the session when an authorized binary read returns 401", async () => {
  await start(async () => Response.json({ message: "Unauthorized" }, { status: 401 }));
  await expect(session.stream("personal-reader@example.com", "/hosted/files/id/name", new AbortController().signal)).rejects.toThrow("Your OpenOrc session ended. Sign in again.");
  expect(session.state).toEqual({ signedIn: false, ended: true });
});

it("bounds the wait for headers without imposing that deadline on a large download", async () => {
  let requestSignal: AbortSignal | null | undefined;
  await start(async (_url, init) => {
    requestSignal = init?.signal;
    return new Response("Content");
  });
  vi.useFakeTimers();
  const response = await session.stream("personal-reader@example.com", "/hosted/files/id/name", new AbortController().signal);
  await vi.advanceTimersByTimeAsync(31_000);
  expect(requestSignal?.aborted).toBe(false);
  expect(await response.text()).toBe("Content");
});
