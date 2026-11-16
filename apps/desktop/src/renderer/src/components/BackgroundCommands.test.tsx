import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BackgroundCommands } from "./BackgroundCommands";
import { ComposerReadOnly } from "./composer-read-only";

afterEach(cleanup);

it("stops the chosen command by id and shows nothing once none run", () => {
  const onStop = vi.fn();
  const commands = [
    { id: "site", description: "Serve the website" },
    { id: "docs", description: "Serve the docs" },
  ];
  const mounted = render(<BackgroundCommands commands={commands} pending={false} onStop={onStop} />);
  fireEvent.click(screen.getByRole("button", { name: "Stop Serve the docs" }));
  expect(onStop).toHaveBeenLastCalledWith("docs");
  mounted.rerender(<BackgroundCommands commands={[]} pending={false} onStop={onStop} />);
  expect(screen.queryByRole("list", { name: "Running in the background" })).toBeNull();
});

it("lets a reader the server lets stop them stop, though the composer is held for their turn", () => {
  const onStop = vi.fn();
  const commands = [{ id: "terminal-1", description: "Terminal" }];
  const held = "Ana's terminal is still open. Stop it before starting your turn.";
  const mounted = render(
    <ComposerReadOnly.Provider value={held}>
      <BackgroundCommands commands={commands} pending={false} canStop onStop={onStop} />
    </ComposerReadOnly.Provider>,
  );
  const stop = screen.getByRole("button", { name: "Stop Terminal" });
  expect(stop).toHaveProperty("disabled", false);
  expect(stop.getAttribute("data-tip")).toBeNull();
  fireEvent.click(stop);
  expect(onStop).toHaveBeenLastCalledWith("terminal-1");
  mounted.rerender(
    <ComposerReadOnly.Provider value={held}>
      <BackgroundCommands commands={commands} pending={false} onStop={onStop} />
    </ComposerReadOnly.Provider>,
  );
  expect(screen.getByRole("button", { name: "Stop Terminal" })).toHaveProperty("disabled", true);
});
