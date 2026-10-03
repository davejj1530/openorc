import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadTitle } from "./ThreadTitle";

afterEach(cleanup);

function EditableTitle({ onSave }: { onSave: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  return <ThreadTitle title="Original title" editing={editing} onEditingChange={setEditing} onSave={onSave} />;
}

it("saves a trimmed title once on Enter and discards a cancelled edit", () => {
  const save = vi.fn();
  render(<EditableTitle onSave={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Rename thread" }));
  let input = screen.getByRole("textbox", { name: "Thread title" });
  fireEvent.change(input, { target: { value: "  New title  " } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.blur(input);
  expect(save).toHaveBeenCalledExactlyOnceWith("New title");

  fireEvent.click(screen.getByRole("button", { name: "Rename thread" }));
  input = screen.getByRole("textbox", { name: "Thread title" });
  fireEvent.change(input, { target: { value: "Discard this" } });
  fireEvent.keyDown(input, { key: "Escape" });
  fireEvent.blur(input);
  expect(save).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Rename thread" }));
  expect(screen.getByRole<HTMLInputElement>("textbox").value).toBe("Original title");
});

it("saves on blur, rejects an empty title, and allows composition to finish before Enter saves", () => {
  const save = vi.fn();
  render(<EditableTitle onSave={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Rename thread" }));
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "New title" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(save).not.toHaveBeenCalled();
  expect(screen.queryByRole("textbox")).not.toBeNull();
  fireEvent.blur(input);
  expect(save).toHaveBeenCalledExactlyOnceWith("New title");
  fireEvent.click(screen.getByRole("button", { name: "Rename thread" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
  fireEvent.blur(screen.getByRole("textbox"));
  expect(save).toHaveBeenCalledTimes(1);
});
