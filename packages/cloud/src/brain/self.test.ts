import { APIError } from "@vercel/sandbox";
import { describe, expect, it } from "vitest";
import { brainSelf, type BrainSession } from "./self.js";

const connection = { token: "tok", teamId: "team", projectId: "prj" };

/** A session whose stop is `expiresAt`, held back at `limit` the way a plan's longest session holds it back. */
function session(expiresAt: number, limit = Infinity) {
  const calls = { extended: [] as number[], stopped: 0, opened: 0 };
  const handle: BrainSession & { expiresAt: Date } = {
    expiresAt: new Date(expiresAt),
    async extendTimeout(duration) {
      calls.extended.push(duration);
      this.expiresAt = new Date(Math.min(this.expiresAt.getTime() + duration, limit));
    },
    async stop() {
      calls.stopped += 1;
    },
  };
  const open = async () => {
    calls.opened += 1;
    return handle;
  };
  return { handle, calls, open };
}

describe("the brain's handle on its own sandbox", () => {
  it("moves its stop to the wanted time only when it would stop sooner, opening the session once", async () => {
    const later = session(Date.now() + 20 * 60_000);
    const self = brainSelf(connection, "brain", later.open);
    expect(await self.extend(10 * 60_000)).toEqual({ expiresAt: later.handle.expiresAt.getTime(), capped: false });
    expect(later.calls.extended).toEqual([]);

    const sooner = session(Date.now() + 60_000);
    const extending = brainSelf(connection, "brain", sooner.open);
    const result = await extending.extend(10 * 60_000);
    expect(sooner.calls.extended).toHaveLength(1);
    expect(result.capped).toBe(false);
    expect(result.expiresAt).toBeGreaterThanOrEqual(Date.now() + 10 * 60_000 - 1000);
    await extending.extend(10 * 60_000);
    expect(sooner.calls.opened).toBe(1);
  });

  it("reports capped once an extension no longer moves the stop", async () => {
    const limit = Date.now() + 5 * 60_000;
    const near = session(Date.now() + 4 * 60_000, limit);
    const self = brainSelf(connection, "brain", near.open);
    expect(await self.extend(10 * 60_000)).toEqual({ expiresAt: limit, capped: false });
    expect(await self.extend(10 * 60_000)).toEqual({ expiresAt: limit, capped: true });
  });

  it("stops its sandbox, and stopping again while it stops is not an error", async () => {
    const running = session(Date.now() + 60_000);
    await brainSelf(connection, "brain", running.open).stop();
    expect(running.calls.stopped).toBe(1);

    const answers = [new APIError(new Response(null, { status: 410 })), new APIError(new Response(null, { status: 422 }), { json: { error: { code: "sandbox_stopping" } } })];
    for (const answer of answers) {
      const stopping = brainSelf(connection, "brain", async () => ({ ...running.handle, stop: () => Promise.reject(answer) }));
      await expect(stopping.stop()).resolves.toBeUndefined();
    }
    const refused = brainSelf(connection, "brain", async () => ({ ...running.handle, stop: () => Promise.reject(new APIError(new Response(null, { status: 403 }))) }));
    await expect(refused.stop()).rejects.toThrow(APIError);
  });

  it("opens the session again after a failed open", async () => {
    const running = session(Date.now() + 60_000);
    let fail = true;
    const self = brainSelf(connection, "brain", async () => {
      if (fail) throw new Error("Vercel is down");
      return running.handle;
    });
    await expect(self.stop()).rejects.toThrow("Vercel is down");
    fail = false;
    await self.stop();
    expect(running.calls.stopped).toBe(1);
  });
});
