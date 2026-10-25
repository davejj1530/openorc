import { expect, it } from "vitest";
import { noticeVisible } from "./index.js";

const notice = { threadId: "thread", taskId: "worker" };

it("counts a notice as seen only where it is on screen and that screen has the person's attention", () => {
  expect(noticeVisible(notice, { focused: true, threadIds: ["thread"], taskId: null })).toBe(true);
  expect(noticeVisible(notice, { focused: true, threadIds: ["other", "thread"], taskId: null })).toBe(true);
  expect(noticeVisible(notice, { focused: true, threadIds: [], taskId: "worker" })).toBe(true);
  expect(noticeVisible(notice, { focused: false, threadIds: ["thread"], taskId: "worker" })).toBe(false);
  expect(noticeVisible(notice, { focused: true, threadIds: ["other"], taskId: "other" })).toBe(false);
  expect(noticeVisible({ threadId: null, taskId: null }, { focused: true, threadIds: [], taskId: null })).toBe(false);
});
