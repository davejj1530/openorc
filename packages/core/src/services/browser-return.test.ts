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

it("holds a sign-in return until the app supplies its result, without forwarding the query", async () => {
  const waiting = await awaitBrowserReturn("/signed-in", 60_000, true);
  let answered = false;
  const response = fetch(`http://127.0.0.1:${waiting.port}/signed-in?code=private&request=one`, { redirect: "manual" }).then((value) => {
    answered = true;
    return value;
  });
  await expect(waiting.query).resolves.toBe("code=private&request=one");
  expect(answered).toBe(false);
  expect((await fetch(`http://127.0.0.1:${waiting.port}/signed-in`)).status).toBe(410);
  waiting.redirect("https://account.example.com/sign-in/complete?outcome=signed-in");
  const page = await response;
  expect(page.status).toBe(303);
  expect(page.headers.get("location")).toBe("https://account.example.com/sign-in/complete?outcome=signed-in");
  expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await page.text()).toBe("");
});

it("closes a held response on cancellation, and settles a canceled wait before a return", async () => {
  const waiting = await awaitBrowserReturn("/signed-in", 60_000, true);
  const response = fetch(`http://127.0.0.1:${waiting.port}/signed-in`);
  await waiting.query;
  waiting.close();
  expect((await response).status).toBe(503);
  const canceled = await awaitBrowserReturn("/signed-in", 60_000, true);
  canceled.redirect("https://account.example.com/sign-in/complete?outcome=failed");
  await expect(canceled.query).rejects.toThrow(/^$/);
});
