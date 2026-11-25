import { describe, expect, it } from "vitest";
import { commitAt, commitIds, withCommitLinks } from "./commit-links";

const sha = "a82dd00da82497abacd40cb445d1b053ccca5a89";

describe("a commit's id in a reply", () => {
  const reply = [
    "Committed as `a82dd00d`, after `a82dd00d` and `6adb13c1`.",
    "```sh",
    "git show `a82dd00d`",
    "```",
    "The word `deadbee` is short, [`a82dd00d`](https://example.com) is a link, and `cafe` is no id.",
  ].join("\n");

  it("finds each id written as inline code once, outside code blocks and links", () => {
    expect(commitIds(reply)).toEqual(["a82dd00d", "6adb13c1", "deadbee"]);
  });

  it("links the ids that name a commit and leaves the rest as they were", () => {
    const linked = withCommitLinks(reply, new Map([["a82dd00d", sha]]));
    expect(linked.split("\n")[0]).toBe(`Committed as [\`a82dd00d\`](commit:${sha}), after [\`a82dd00d\`](commit:${sha}) and \`6adb13c1\`.`);
    expect(linked.split("\n").slice(1)).toEqual(reply.split("\n").slice(1));
  });

  it("reads the commit a pressed link names", () => {
    expect(commitAt(`commit:${sha}`)).toBe(sha);
    expect(commitAt("https://example.com")).toBeNull();
  });
});
