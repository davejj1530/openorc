// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HostContext } from "../connection/host-context";
import { HomeHeading } from "./HomeHeading";

const pushed = vi.hoisted(() => [] as unknown[]);
vi.mock("expo-router", () => ({ router: { push: (to: unknown) => void pushed.push(to) } }));
afterEach(() => {
  cleanup();
  pushed.length = 0;
});

const heading = { kind: "heading", key: "project:cloud-website", group: "project", projectId: "cloud-website", title: "website", meta: null, open: true } as const;

it("starts a thread on the host whose section it heads: the cloud brain's under its heading, the shown host's otherwise", () => {
  const brain = render(
    <HostContext.Provider value="brain-key">
      <HomeHeading heading={heading} onToggle={() => undefined} />
    </HostContext.Provider>,
  );
  fireEvent.click(brain.getByLabelText("New thread in website"));
  expect(pushed).toEqual([{ pathname: "/new", params: { projectId: "cloud-website", host: "brain-key" } }]);
  cleanup();
  const shown = render(<HomeHeading heading={{ ...heading, projectId: "website" }} onToggle={() => undefined} />);
  fireEvent.click(shown.getByLabelText("New thread in website"));
  expect(pushed.at(-1)).toEqual({ pathname: "/new", params: { projectId: "website" } });
});

it("offers no new thread under a Mac out of reach, and still folds there", () => {
  const toggled = vi.fn();
  const view = render(<HomeHeading heading={{ ...heading, projectId: "website", owner: { brain: "mac", reach: "offline", heardAt: 1 } }} onToggle={toggled} />);
  expect(view.queryByLabelText("New thread in website")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "website" }));
  expect(toggled).toHaveBeenCalledOnce();
  cleanup();
  const live = render(<HomeHeading heading={{ ...heading, owner: { brain: "cloud", reach: "asleep", heardAt: 1 } }} onToggle={() => undefined} />);
  expect(live.getByLabelText("New thread in website")).toBeTruthy();
});
