import { expect, vi } from "vitest";
import type { HostedDeps } from "../index.js";
import { createHosted } from "../index.js";
import { Session } from "../session.js";
import { OnlineTasks, type TaskDelivery } from "../tasks.js";
import type { StandIn } from "../testing/stand-in.js";
import { hostDeps, newDevice, signInAs, storedToken } from "./host.js";

export async function taskClient(stand: StandIn, email: string, delivery: TaskDelivery, overrides: Partial<HostedDeps> = {}) {
  const device = newDevice();
  const { deps, browser, seen } = hostDeps(stand, device, overrides);
  const hosted = createHosted(deps);
  const session = new Session(deps);
  const tasks = new OnlineTasks({
    session,
    spaces: hosted.spaces,
    push: deps.push,
    delivery,
    prepared: async (threadId) => {
      await vi.waitFor(() => expect(hosted.threads.holds({ thread: threadId })).toBe(true));
    },
  });
  const close = () => {
    tasks.close();
    session.close();
    hosted.close();
  };
  try {
    await hosted.start();
    await signInAs(hosted, browser, email);
    await vi.waitFor(() => expect(hosted.spaces.status().state).toBe("ready"));
    await session.begin(storedToken(device), email);
    return { tasks, session, hosted, seen, close };
  } catch (error) {
    close();
    throw error;
  }
}
