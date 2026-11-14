import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { cloudReviewThread, localReviewThread, reviewProject } from "../components/test-fixtures/hosted-review";
import { ThreadView } from "./ThreadView";

const read = vi.hoisted(() => vi.fn());
const current = vi.hoisted(() => ({ cloud: true }));
vi.mock("../lib/space-queries", () => ({ useUnavailableThread: () => null, useSpaceThread: () => ({ data: current.cloud ? cloudReviewThread : localReviewThread, isSuccess: true }) }));
vi.mock("../lib/client", () => ({
  useRpc: (method: string) => {
    read(method);
    return { data: method === "projects.get" ? reviewProject : [], isSuccess: true };
  },
  useRpcMutation: () => ({ mutate: vi.fn() }),
}));
vi.mock("../lib/read-while-shown", () => ({ useReadWhileShown: () => {} }));
vi.mock("../components/Conversation", () => ({ Conversation: () => <div>Conversation</div> }));
vi.mock("../components/ThreadHeader", () => ({ ThreadHeader: () => null, ThreadHeaderPlaceholder: () => null }));
vi.mock("./UnavailableThread", () => ({ UnavailableThread: () => null }));
afterEach(() => {
  cleanup();
  read.mockClear();
});
it.each([true, false])("only watches stored plans where they can be read (hosted=%s)", (cloud) => {
  current.cloud = cloud;
  render(<ThreadView threadId="example-thread" first last focused />);
  expect(read.mock.calls.some(([method]) => method === "threads.plans")).toBe(!cloud);
});
