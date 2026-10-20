import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TargetBranchField, type TargetBranch } from "./PullRequestTarget";

afterEach(cleanup);

function target(overrides: Partial<TargetBranch> = {}): TargetBranch {
  return { value: "main", choose: vi.fn(), options: ["main", "dev", "release"], loading: false, error: null, ...overrides };
}

it("grows the branch list out of its pill and chooses the branch you pick", async () => {
  const branch = target();
  render(<TargetBranchField target={branch} disabled={false} />);
  const pill = screen.getByRole<HTMLButtonElement>("combobox", { name: "Target branch" });
  expect(pill.textContent).toBe("main");

  fireEvent.click(pill);
  const list = await screen.findByLabelText("Branches");
  expect(list.classList.contains("menu-grow")).toBe(true);
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["main", "dev", "release"]);

  fireEvent.click(screen.getByRole("option", { name: "dev" }));
  expect(branch.choose).toHaveBeenCalledWith("dev");
});

it("filters the list, and the filter is gone when the list opens again", async () => {
  render(<TargetBranchField target={target()} disabled={false} />);
  const pill = screen.getByRole("combobox", { name: "Target branch" });
  fireEvent.click(pill);
  const filter = await screen.findByPlaceholderText("Filter branches");
  fireEvent.change(filter, { target: { value: "rel" } });
  await waitFor(() => expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["release"]));

  fireEvent.keyDown(filter, { key: "Escape" });
  await waitFor(() => expect(screen.queryByPlaceholderText("Filter branches")).toBeNull());
  fireEvent.click(pill);
  expect(((await screen.findByPlaceholderText("Filter branches")) as HTMLInputElement).value).toBe("");
});

it("explains why the branches could not load and keeps the pill shut", () => {
  render(<TargetBranchField target={target({ error: new Error("GitHub is unreachable") })} disabled={false} />);
  expect(screen.getByText("GitHub is unreachable")).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("combobox", { name: /^Target branch/ }).disabled).toBe(true);
});
