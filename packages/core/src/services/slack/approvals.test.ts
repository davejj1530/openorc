import { expect, it, vi } from "vitest";
import { SlackApprovals } from "./approvals.js";
const job = { id: "job", workspaceId: "T", userId: "U", channelId: "C", threadTs: "1", text: "read" };
const request = { id: "ae89685b-277e-440c-b45a-90679255c2aa", text: "echo hello", canAllow: true };
const action = (patch = {}) => ({
  type: "block_actions",
  team: { id: "T" },
  user: { id: "U" },
  container: { channel_id: "C", message_ts: "2" },
  actions: [{ action_id: "openorc_allow", value: request.id }],
  ...patch,
});
it("binds single-use approvals to workspace, owner, channel and message and retries delivery until desktop acknowledgement", async () => {
  const post = vi.fn(async () => "2"),
    update = vi.fn(async () => {});
  const relay = new SlackApprovals(post, update);
  expect(await relay.sync(job, [request])).toEqual([]);
  for (const patch of [{ team: { id: "OTHER" } }, { user: { id: "OTHER" } }, { container: { channel_id: "OTHER", message_ts: "2" } }, { container: { channel_id: "C", message_ts: "3" } }])
    expect(relay.act(action(patch))).toBe(false);
  expect(relay.act(action())).toBe(true);
  expect(relay.act(action())).toBe(false);
  expect(await relay.sync(job, [request])).toEqual([{ id: request.id, decision: "allow" }]);
  expect(await relay.sync(job, [request])).toEqual([{ id: request.id, decision: "allow" }]);
  expect(post).toHaveBeenCalledTimes(1);
  await relay.sync(job, []);
  expect(update).toHaveBeenCalledWith(job, "2", "This request is no longer pending on your desktop.");
  expect(relay.act(action())).toBe(false);
});
it("invalidates desktop-resolved, revoked and expired requests and never enables truncated approvals", async () => {
  const relay = new SlackApprovals(
    async () => "2",
    async () => {},
  );
  await relay.sync(job, [{ ...request, canAllow: false }]);
  expect(relay.act(action())).toBe(false);
  await relay.sync(job, []);
  expect(relay.act(action())).toBe(false);
  await relay.sync(job, [request]);
  relay.revoke(job.id);
  expect(relay.act(action())).toBe(false);
  const fresh = new SlackApprovals(
    async () => "2",
    async () => {},
  );
  await fresh.sync(job, [request]);
  const now = Date.now();
  const spy = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
  expect(fresh.act(action())).toBe(false);
  spy.mockRestore();
});

it("delivers all long-request pages before enabling approval and resumes a failed page", async () => {
  const pages: import("./approvals.js").ApprovalPage[] = [];
  let fail = true;
  const post = vi.fn(async (_job, page: import("./approvals.js").ApprovalPage) => {
    if (page.part === 2 && fail) {
      fail = false;
      throw new Error("temporary Slack failure");
    }
    pages.push(page);
    return String(page.part);
  });
  const relay = new SlackApprovals(post, async () => {});
  const long = { ...request, text: "a".repeat(2799) + "🌙" + "b".repeat(14000) };
  await expect(relay.sync(job, [long])).rejects.toThrow("temporary Slack failure");
  expect(relay.act(action({ container: { channel_id: "C", message_ts: "1" } }))).toBe(false);
  await relay.sync(job, [long]);
  expect(pages.map((p) => p.part)).toEqual([1, 2]);
  expect(pages.map((p) => p.text).join("")).toBe(long.text);
  expect(pages.every((p) => p.text.length <= 11200)).toBe(true);
  expect(relay.act(action())).toBe(true);
  expect(await relay.sync(job, [long])).toEqual([{ id: request.id, decision: "allow" }]);
  expect(post).toHaveBeenCalledTimes(3);
});

it("shares in-flight page delivery on retry and refuses changed approval contents", async () => {
  let release!: () => void;
  const post = vi.fn(async () => {
    await new Promise<void>((r) => {
      release = r;
    });
    return "2";
  });
  const relay = new SlackApprovals(post, async () => {});
  const first = relay.sync(job, [request]);
  const retry = relay.sync(job, [request]);
  expect(post).toHaveBeenCalledTimes(1);
  expect(relay.act(action())).toBe(false);
  release();
  await Promise.all([first, retry]);
  await expect(relay.sync(job, [{ ...request, text: "different command" }])).rejects.toThrow("Approval details changed");
  expect(relay.act(action())).toBe(true);
});
