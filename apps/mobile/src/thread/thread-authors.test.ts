import type { ThreadAuthors } from "@openorc/protocol";
import { expect, it, vi } from "vitest";
import { otherAuthor } from "./thread-authors";

vi.mock("../client", () => ({}));

const riley = { id: "u-riley", name: "Riley Chen", image: null };
const mara = { id: "u-mara", name: "Mara Okafor", image: null };
const authors: ThreadAuthors = { viewer: riley, turnOf: {}, senders: {}, authors: { mine: riley, hers: mara, gone: null } };

it("names a teammate over their message by first name, and nobody over the reader's own", () => {
  expect(otherAuthor(authors, "hers")).toBe("Mara");
  expect(otherAuthor(authors, "mine")).toBeNull();
  expect(otherAuthor(authors, "gone")).toBe("Former member");
  expect(otherAuthor(authors, "unnamed")).toBeNull();
  expect(otherAuthor(null, "hers")).toBeNull();
});
