import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";
import { wireThreadDetail } from "./wire.js";

let stand: StandIn;
let hosted: Hosted;
let threadId: string;
let response: unknown;
let status: number;
let changesStatus: number;
let paths: string[];
let detailStatus: number;
let publishing: boolean;
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  threadId = stand.addThread("reader@example.com", { title: "Example", projectId: null });
  status = 200;
  changesStatus = 200;
  detailStatus = 200;
  publishing = true;
  response = { version: 1, features: { changes: { available: true }, terminal: { available: false, reason: "A terminal isn't available in this cloud thread yet." }, future: { available: true } } };
  paths = [];
  const { deps, browser } = hostDeps(stand, newDevice(), {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/hosted/capabilities") {
        paths.push(url.pathname);
        expect(new Headers(init?.headers).get("x-openorc-space")).toBeTruthy();
        return Response.json(response, { status });
      }
      if (url.pathname.endsWith("/changes")) {
        paths.push(url.pathname);
        return Response.json(changesStatus === 200 ? { state: "none", line: "No turn has ended yet." } : { message: "That thread is unavailable." }, { status: changesStatus });
      }
      if (url.pathname === `/hosted/threads/${threadId}` && status === 404) {
        if (detailStatus !== 200) return Response.json({ message: "This project is unavailable." }, { status: detailStatus });
        const detail = wireThreadDetail.parse(await (await fetch(input, init)).json());
        if (!publishing) return Response.json(detail);
        return Response.json({ ...detail, branch: "example", baseBranch: "main", work: { uncommitted: null, unpushed: null, published: false }, actions: [], pullRequest: null });
      }
      return fetch(input, init);
    },
  });
  hosted = createHosted(deps);
  await hosted.start();
  await signInAs(hosted, browser, "reader@example.com");
  await vi.waitFor(() => expect(hosted.threads.holds({ thread: threadId })).toBe(true));
});
afterEach(async () => {
  hosted.close();
  await stand.close();
});

it("reads capabilities in the thread's space and ignores unknown feature keys", async () => {
  expect(await hosted.threads.call("hosted.capabilities", { threadId })).toEqual({
    version: 1,
    features: { changes: { available: true }, terminal: { available: false, reason: "A terminal isn't available in this cloud thread yet." } },
  });
});
it("uses a readable old server's existing routes without inventing other capabilities", async () => {
  status = 404;
  response = { message: "Not found" };
  expect(await hosted.threads.call("hosted.capabilities", { threadId })).toEqual({ version: 1, features: { changes: { available: true }, publishing: { available: true } } });
  expect(paths).toContain(`/hosted/threads/${threadId}/changes`);
});
it("does not probe a missing feature route after thread access is refused", async () => {
  status = 404;
  response = { message: "Not found" };
  await hosted.account.signOut();
  await expect(hosted.threads.call("hosted.capabilities", { threadId })).rejects.toThrow();
  expect(paths).toEqual([]);
});
it("preserves failure and denied-access responses instead of treating them as old-server absence", async () => {
  status = 503;
  response = { message: "Capabilities could not be read." };
  await expect(hosted.threads.call("hosted.capabilities", { threadId })).rejects.toThrow("Capabilities could not be read.");
  expect(paths).toEqual(["/hosted/capabilities"]);
});

it("keeps unavailable review controls quiet on a readable older server", async () => {
  status = 404;
  response = { message: "Not found" };
  changesStatus = 404;
  publishing = false;
  expect(await hosted.threads.call("hosted.capabilities", { threadId })).toEqual({
    version: 1,
    features: {
      publishing: { available: false, reason: "Publishing isn't available in this cloud thread yet." },
      changes: { available: false, reason: "Saved changes aren't available in this cloud thread yet." },
    },
  });
});
it("does not mistake a denied thread for an older server's missing route", async () => {
  status = 404;
  response = { message: "Not found" };
  detailStatus = 403;
  await expect(hosted.threads.call("hosted.capabilities", { threadId })).rejects.toThrow("This project is unavailable.");
  expect(paths).toEqual(["/hosted/capabilities"]);
});
