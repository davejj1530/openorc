import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BackgroundCommands } from "./BackgroundCommands";

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
