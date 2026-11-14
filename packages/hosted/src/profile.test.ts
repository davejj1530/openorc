import { afterEach, beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { hostDeps, newDevice, signInAs, storedToken } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const SELF = "alex@example.com";
const TEAMMATE = "mira@example.com";
const RECIPIENT = "robin@example.com";
let stand: StandIn;
const hosts: Hosted[] = [];
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
});
afterEach(async () => {
  hosts.splice(0).forEach((host) => host.close());
  await stand.close();
});
async function host(email = SELF, overrides: Partial<HostedDeps> = {}) {
  const device = newDevice();
  const { deps, seen, browser } = hostDeps(stand, device, overrides);
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, email);
  await vi.waitFor(() => expect(hosted.spaces.status().state).toBe("ready"));
  return { hosted, seen, device };
}
const picture = async () =>
  `data:image/png;base64,${(
    await sharp({ create: { width: 128, height: 128, channels: 3, background: "#445566" } })
      .png()
      .toBuffer()
  ).toString("base64")}`;

it("saves a normalized name and picture atomically, removes the picture and ignores a space header", async () => {
  const { hosted, device } = await host();
  await hosted.account.updateProfile({ name: "  Ａlex   Rivera ", image: await picture() });
  expect(hosted.account.status()).toMatchObject({ name: "Alex Rivera", image: expect.stringMatching(/^data:image\/webp;base64,/) });
  await expect(hosted.account.updateProfile({ name: "Not saved", image: "data:image/webp;base64,UklGRg==" })).rejects.toThrow("That file isn't the picture it says it is.");
  expect(hosted.account.status()).toMatchObject({ name: "Alex Rivera" });
  const response = await fetch(`${stand.url}/account/profile`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${storedToken(device)}`, "content-type": "application/json", "x-openorc-space": "not-a-space" },
    body: JSON.stringify({ image: null, id: "someone-else", email: TEAMMATE }),
  });
  expect(await response.json()).toEqual({ id: `user-${SELF}`, email: SELF, name: "Alex Rivera", image: null });
  await vi.waitFor(() => expect(hosted.account.status()).toMatchObject({ name: "Alex Rivera", image: null }));
});

it.each([
  ["", "Give your name."],
  ["x".repeat(81), "Keep the name under 80 characters."],
  ["Alex\u200b", "That name has characters that don't show. Type it again."],
  ["example.dev", "Use a name, not a link or a web address."],
])("keeps a refused name unchanged: %s", async (name, message) => {
  const { hosted } = await host();
  await expect(hosted.account.updateProfile({ name })).rejects.toThrow(message);
  expect(hosted.account.status()).toMatchObject({ name: "Alex", image: null });
});

it("refreshes another own session, a teammate's starter and People, and a pending recipient's inviter", async () => {
  const spaceId = stand.addTeam("Birch Studio", [SELF, TEAMMATE]);
  const projectId = stand.addProject(SELF, { name: "Canvas", fullName: "example/canvas" }, spaceId);
  const threadId = stand.addThread(SELF, { projectId, title: "Review the canvas" });
  const inviteId = stand.organizations.invite(spaceId, RECIPIENT, SELF);
  const { hosted: first } = await host();
  const { hosted: second } = await host();
  const { hosted: teammate, seen } = await host(TEAMMATE);
  const { hosted: recipient } = await host(RECIPIENT);
  await first.account.updateProfile({ name: "Alex Rivera", image: await picture() });
  const account = first.account.status();
  if (account.state !== "signed-in") throw Error("Missing account");
  const expected = { name: "Alex Rivera", image: account.image };
  await vi.waitFor(() => expect(second.account.status()).toMatchObject(expected));
  await vi.waitFor(() => expect(seen.pushes).toContainEqual({ type: "invalidate", keys: [`people:${spaceId}`, `invitations:${spaceId}`] }));
  expect((await teammate.spaces.people(spaceId)).members.find((member) => member.email === SELF)).toMatchObject(expected);
  await vi.waitFor(() => expect(teammate.threads.listed("threads.list", {})?.rows.find((row) => row.id === threadId)?.owner?.startedBy).toEqual(expected));
  await vi.waitFor(() => expect(recipient.spaces.status()).toMatchObject({ invitations: [{ id: inviteId, inviter: expected }] }));
});

it("keeps a successful PATCH when following session reads fail", async () => {
  let refuseReads = false;
  const { hosted } = await host(SELF, {
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (refuseReads && path === "/api/auth/get-session") throw Error("Read lost");
      const response = await fetch(input, init);
      if (path === "/account/profile") refuseReads = true;
      return response;
    },
  });
  await hosted.account.updateProfile({ name: "Alex Rivera" });
  hosted.awoke();
  await vi.waitFor(() => expect(hosted.account.status()).toMatchObject({ name: "Alex Rivera" }));
  expect(stand.requests.filter((request) => request.path === "/account/profile")).toHaveLength(1);
});

it("does not let a delayed old session read overwrite a saved profile", async () => {
  let held: (() => void) | undefined;
  let hold = false;
  const { hosted } = await host(SELF, {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (hold && new URL(String(input)).pathname === "/api/auth/get-session") {
        hold = false;
        const snapshot = await response.text();
        await new Promise<void>((resolve) => {
          held = resolve;
        });
        return new Response(snapshot);
      }
      return response;
    },
  });
  hold = true;
  stand.organizations.profileChanged(SELF);
  await vi.waitFor(() => expect(held).toBeTypeOf("function"));
  await hosted.account.updateProfile({ name: "Alex Rivera" });
  held!();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await vi.waitFor(() => expect(hosted.account.status()).toMatchObject({ name: "Alex Rivera" }));
});
