import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ThreadMedia, ThreadRichText } from "./ThreadImages";
import { teamMentionNames } from "../lib/mention-names";
import { teamChatText } from "../lib/team-transcript";
import type { TeamChatEntry } from "@openorc/protocol";

afterEach(cleanup);
const key = "81719fd4-4e0c-4601-8e2b-2c3af4347798";
const identity = "7c704dc1-c5ae-4377-b97b-2c8b6d93716b";
const names = teamMentionNames([{ key, name: "Dario", managerKey: null }], [{ id: identity, memberKey: key }]);

it("preserves code, link destinations, email addresses, unknown IDs and longer tokens", () => {
  const text = `@${key} please review.\n\n\`@${key}\`\n\n\`\`\`text\n@${key}\n\`\`\`\n\n[Reference](https://example.com/@${key})\n\nuser@${key} @${key}-suffix @unknown-id`;
  const { container } = render(
    <ThreadMedia scopeKey="team" mentionNames={names}>
      <ThreadRichText>{text}</ThreadRichText>
    </ThreadMedia>,
  );
  expect(screen.getByText("@Dario please review.")).toBeTruthy();
  expect(container.querySelectorAll("code")).toHaveLength(2);
  expect([...container.querySelectorAll("code")].every((node) => node.textContent?.includes(`@${key}`))).toBe(true);
  expect(screen.getByRole("link", { name: "Reference" }).getAttribute("href")).toBe(`https://example.com/@${key}`);
  expect(screen.getByText(`user@${key} @${key}-suffix @unknown-id`)).toBeTruthy();
});

it.each([`**@${identity}**: let me know.`])("uses pinned identities without adding a duplicate addressee to %s", (message) => {
  const entry: TeamChatEntry = {
    id: "chat",
    senderId: "member:boris",
    senderName: "Boris",
    createdAt: 1,
    attachments: [],
    text: message,
    to: [{ actorId: "lead", name: "Dario", state: "delivered" }],
  };
  const original = entry.text;
  const text = teamChatText(entry, names);
  const { container } = render(
    <ThreadMedia scopeKey="team" mentionNames={names}>
      <ThreadRichText>{text}</ThreadRichText>
    </ThreadMedia>,
  );
  expect(container.querySelector("p")?.textContent).toBe("@Dario: let me know.");
  expect(entry.text).toBe(original);
});

it("keeps a roster name literal instead of interpreting it as Markdown or HTML", () => {
  const literal = new Map([[key, "Dario *QA* <test>"]]);
  const { container } = render(
    <ThreadMedia scopeKey="team" mentionNames={literal}>
      <ThreadRichText>{`@${key} ready.`}</ThreadRichText>
    </ThreadMedia>,
  );
  expect(screen.getByText("@Dario *QA* <test> ready.")).toBeTruthy();
  expect(container.querySelector("em, test")).toBeNull();
});
