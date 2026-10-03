import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TeamConversationTools } from "./TeamConversationTools";

afterEach(cleanup);

it("puts team controls in their own toolbar and keeps activity and compaction available", async () => {
  const target = document.createElement("span");
  document.body.append(target);
  const change = vi.fn();
  const compact = vi.fn();
  const { container, unmount } = render(
    <TeamConversationTools
      target={target}
      name="Product team"
      version={3}
      status="Completed"
      working={null}
      showActivity={false}
      onShowActivity={change}
      compact={{ label: "Compact lead context", description: "History and files are kept.", disabled: false, pending: false, run: compact }}
    />,
  );
  expect(container.querySelector(".team-tools-inline")).toBeNull();
  fireEvent.click(within(target).getByRole("button", { name: "Team controls: Completed" }));
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Show activity" }));
  expect(change).toHaveBeenCalledWith(true, expect.anything());
  // A checkbox leaves the menu open so adjacent team controls remain reachable.
  fireEvent.click(screen.getByRole("menuitem", { name: "Compact lead context" }));
  expect(compact).toHaveBeenCalledTimes(1);
  unmount();
  target.remove();
});

it("keeps a pending request visible and disables unavailable context actions", async () => {
  const compact = vi.fn();
  render(
    <TeamConversationTools
      name="Product team"
      version={1}
      status="Working"
      working="Lead is thinking"
      showActivity={true}
      onShowActivity={vi.fn()}
      compact={{ label: "Compacting…", description: "Wait for the saved request.", disabled: true, pending: true, run: compact }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Team controls: Compacting…" }));
  const item = await screen.findByRole("menuitem", { name: "Compacting…" });
  expect(item.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(item);
  expect(compact).not.toHaveBeenCalled();
});
