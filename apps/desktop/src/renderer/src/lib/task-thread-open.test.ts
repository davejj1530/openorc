import { expect, it, vi } from "vitest";
import type { OnlineTaskPreparation } from "@openorc/protocol";
import { TaskThreadOpener } from "./task-thread-open";
import { onlineReference, onlineTask } from "./test-fixtures/online-task";

const scope = { apiOrigin: "https://example.com", accountId: onlineReference.accountId, spaceId: onlineReference.spaceId };
const ready = (): OnlineTaskPreparation => ({ state: "ready", accessRevision: 1, task: onlineTask(), threadId: "carrying-thread", created: true, draft: "Task words" });
const fixture = () => ({ scope, task: () => onlineTask(), flush: vi.fn(async () => true), current: () => true, files: vi.fn(async () => 0), stage: vi.fn(), navigate: vi.fn() });

it("flushes before capturing the revision and waits for existing files before staging", async () => {
  let revision = 1;
  const prepare = vi.fn(async () => ready());
  const open = new TaskThreadOpener(onlineReference, prepare);
  const input = fixture();
  input.flush = vi.fn(async () => {
    revision = 2;
    return true;
  });
  input.task = () => onlineTask({ revision });
  input.files = vi.fn(async () => 2);
  await open.open(input);
  expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ ifRevision: 2, id: onlineReference.id, spaceId: scope.spaceId }));
  expect(input.stage).toHaveBeenCalledWith(scope, onlineReference, ready(), 2);
  expect(input.navigate).toHaveBeenCalledWith("carrying-thread");
});
it("makes a task's new thread with the model a new cloud thread starts with", async () => {
  const prepare = vi.fn(async () => ready());
  const settings = { agent: "claude", model: "claude-sonnet-5", effort: "medium" } as const;
  await new TaskThreadOpener(onlineReference, prepare).open({ ...fixture(), settings });
  expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ settings }));
});
it("retains a lost reply's request id and revision before considering later words", async () => {
  const prepare = vi.fn<() => Promise<OnlineTaskPreparation>>().mockRejectedValueOnce(new Error("Lost reply")).mockResolvedValue(ready());
  const open = new TaskThreadOpener(onlineReference, prepare);
  const input = fixture();
  await expect(open.open(input)).rejects.toThrow("Lost reply");
  input.task = () => onlineTask({ revision: 9 });
  await open.open(input);
  expect(prepare.mock.calls[1]).toEqual(prepare.mock.calls[0]);
});
it("requires a fresh explicit open after a revision conflict without staging or navigating", async () => {
  const conflict: OnlineTaskPreparation = { state: "conflict", accessRevision: 1, task: onlineTask({ revision: 2 }) };
  const prepare = vi.fn<() => Promise<OnlineTaskPreparation>>().mockResolvedValueOnce(conflict).mockResolvedValue(ready());
  const open = new TaskThreadOpener(onlineReference, prepare),
    input = fixture();
  expect(await open.open(input)).toEqual(conflict);
  expect(input.stage).not.toHaveBeenCalled();
  expect(input.navigate).not.toHaveBeenCalled();
  input.task = () => conflict.task;
  await open.open(input);
  expect(prepare.mock.calls[1]).not.toEqual(prepare.mock.calls[0]);
});
it.each(["flush", "reply", "files"] as const)("rejects lost authority during %s before any late staging or navigation", async (step) => {
  let allowed = true;
  const input = fixture();
  input.current = () => allowed;
  input.flush = vi.fn(async () => {
    if (step === "flush") allowed = false;
    return true;
  });
  const prepare = vi.fn(async () => {
    if (step === "reply") allowed = false;
    return ready();
  });
  input.files = vi.fn(async () => {
    if (step === "files") allowed = false;
    return 0;
  });
  await expect(new TaskThreadOpener(onlineReference, prepare).open(input)).rejects.toThrow("access changed");
  expect(input.stage).not.toHaveBeenCalled();
  expect(input.navigate).not.toHaveBeenCalled();
  if (step === "flush") expect(prepare).not.toHaveBeenCalled();
});
it("a failed file read preserves the draft and never assumes that it is empty", async () => {
  const input = fixture();
  input.files.mockRejectedValue(new Error("Files unavailable"));
  await expect(new TaskThreadOpener(onlineReference, async () => ready()).open(input)).rejects.toThrow("Files unavailable");
  expect(input.stage).not.toHaveBeenCalled();
  expect(input.navigate).not.toHaveBeenCalled();
});
