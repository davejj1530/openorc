import type { HostedTerminalPush } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn, type StandInBilling } from "./testing/stand-in.js";

const ADA = "ada@example.com";
const BEN = "ben@example.com";
const PRO: StandInBilling = { pro: true, standing: "live", at: new Date(Date.now() + 20 * 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 };
const ON = { terminal: { available: true } } as const;

let stand: StandIn;
const hosts: Hosted[] = [];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  for (const who of [ADA, BEN]) stand.setBilling(who, PRO);
  stand.threadFiles.capabilities = ON;
});

afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

/** Ada's thread in a team of Ada and Ben, heard by a signed-in host of `who`. */
async function hostOf(who: string, thread: string) {
  const { deps, seen, browser } = hostDeps(stand, newDevice());
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, who);
  await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(true));
  const pushes = () => seen.pushes.filter((push): push is HostedTerminalPush => (push as { type?: string }).type === "hosted.terminal");
  return { hosted, pushes };
}

function teamThread() {
  const space = stand.addTeam("Example team", [ADA, BEN]);
  const project = stand.addProject(ADA, { name: "api", fullName: "example/api" }, space);
  return stand.addThread(ADA, { projectId: project, title: "Run the tests" });
}

const text = (base64: string) => Buffer.from(base64, "base64").toString("utf8");

describe("a cloud thread's terminal, as the window's panel asks for it", () => {
  it("opens one, types once per keystroke, reads it from an offset, and hears it live once watched", async () => {
    const thread = teamThread();
    const { hosted, pushes } = await hostOf(ADA, thread);
    const listed = await hosted.threads.call("hosted.terminal.list", { threadId: thread });
    expect(listed).toMatchObject({ terminals: [], canOpen: true, reason: null, viewer: expect.any(String) });
    const terminal = await hosted.threads.call("hosted.terminal.open", { threadId: thread, cols: 100, rows: 24 });
    expect(terminal).toMatchObject({ state: "open", cols: 100, rows: 24, openedBy: { name: expect.any(String) }, ended: null });
    expect(terminal.openedBy.id).toBe(listed.viewer);
    await hosted.threads.call("hosted.terminal.watch", { threadId: thread, terminalId: terminal.id, watch: true });
    expect(await hosted.threads.call("hosted.terminal.input", { threadId: thread, terminalId: terminal.id, at: 0, data: "ls\r" })).toEqual({ at: 3 });
    // Sent again after a lost answer, typed once.
    expect(await hosted.threads.call("hosted.terminal.input", { threadId: thread, terminalId: terminal.id, at: 0, data: "ls\r" })).toEqual({ at: 3 });
    const read = await hosted.threads.call("hosted.terminal.output", { threadId: thread, terminalId: terminal.id, from: 0 });
    expect(text(read.data)).toBe("$ ls\r\n$ ");
    expect(await hosted.threads.call("hosted.terminal.output", { threadId: thread, terminalId: terminal.id, from: 2 })).toMatchObject({ from: 2, end: read.end });
    await vi.waitFor(() =>
      expect(
        pushes()
          .filter((push) => push.event.kind === "output")
          .map((push) => push.event.kind === "output" && text(push.event.data))
          .join(""),
      ).toBe("ls\r\n$ "),
    );
    expect(await hosted.threads.call("hosted.terminal.size", { threadId: thread, terminalId: terminal.id, cols: 132, rows: 41 })).toMatchObject({ cols: 132, rows: 41 });
    const ended = await hosted.threads.call("hosted.terminal.end", { threadId: thread, terminalId: terminal.id });
    expect(ended).toMatchObject({ state: "ended", ended: { reason: "closed", message: "Ada ended this terminal." } });
    await vi.waitFor(() => expect(pushes().some((push) => push.event.kind === "changed" && push.event.terminal.state === "ended")).toBe(true));
  });

  it("lets a teammate watch and refuses their keystrokes in words, and hears nothing once it stops watching", async () => {
    const thread = teamThread();
    const ada = await hostOf(ADA, thread);
    const terminal = await ada.hosted.threads.call("hosted.terminal.open", { threadId: thread, cols: 80, rows: 24 });
    const ben = await hostOf(BEN, thread);
    expect(await ben.hosted.threads.call("hosted.terminal.list", { threadId: thread })).toMatchObject({
      canOpen: false,
      reason: "Ada's terminal is open here. End it to open yours.",
      terminals: [{ id: terminal.id }],
    });
    await ben.hosted.threads.call("hosted.terminal.watch", { threadId: thread, terminalId: terminal.id, watch: true });
    await expect(ben.hosted.threads.call("hosted.terminal.input", { threadId: thread, terminalId: terminal.id, at: 0, data: "x" })).rejects.toThrow("Only Ada can type in this terminal.");
    await ada.hosted.threads.call("hosted.terminal.input", { threadId: thread, terminalId: terminal.id, at: 0, data: "pwd\r" });
    await vi.waitFor(() => expect(ben.pushes().some((push) => push.event.kind === "output" && text(push.event.data).includes("pwd"))).toBe(true));
    await ben.hosted.threads.call("hosted.terminal.watch", { threadId: thread, terminalId: terminal.id, watch: false });
    const heard = ben.pushes().length;
    await ada.hosted.threads.call("hosted.terminal.input", { threadId: thread, terminalId: terminal.id, at: 4, data: "date\r" });
    expect(text((await ada.hosted.threads.call("hosted.terminal.output", { threadId: thread, terminalId: terminal.id, from: 0 })).data)).toContain("date");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ben.pushes()).toHaveLength(heard);
  });

  it("says the server's reason where terminals are off", async () => {
    const thread = teamThread();
    const { hosted } = await hostOf(ADA, thread);
    stand.threadFiles.capabilities = { terminal: { available: false, reason: "The terminal isn't available in cloud threads yet." } };
    await expect(hosted.threads.call("hosted.terminal.list", { threadId: thread })).rejects.toThrow("The terminal isn't available in cloud threads yet.");
  });
});
