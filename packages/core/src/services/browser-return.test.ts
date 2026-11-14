import { expect, it } from "vitest";
import { awaitBrowserReturn } from "./browser-return.js";

it("answers one return on its path with a page, hands its query on unread, and stops listening", async () => {
  const waiting = await awaitBrowserReturn("/github-return", 60_000);
  expect((await fetch(`http://127.0.0.1:${waiting.port}/elsewhere`)).status).toBe(404);
  const page = await fetch(`http://127.0.0.1:${waiting.port}/github-return?code=abc&state=s%2F1`);
  expect(await page.text()).toContain("You can return to OpenOrc. You can close this tab.");
  await expect(waiting.query).resolves.toBe("code=abc&state=s%2F1");
  await expect(fetch(`http://127.0.0.1:${waiting.port}/github-return`)).rejects.toThrow();
});

it("gives up after its time with words to try again, and a cancel leaves no words", async () => {
  const late = await awaitBrowserReturn("/github-return", 20);
  await expect(late.query).rejects.toThrow("The browser didn't come back in time. Try again.");
  const cancelled = await awaitBrowserReturn("/github-return", 60_000);
  cancelled.close();
  await expect(cancelled.query).rejects.toThrow(/^$/);
});
