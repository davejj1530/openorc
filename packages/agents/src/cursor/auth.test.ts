import { expect, it } from "vitest";
import { cursorAuthenticated } from "./auth.js";

it("requires Cursor's authenticated flag, including when a partial login has an access token", () => {
  expect(cursorAuthenticated('{"status":"authenticated","isAuthenticated":true}')).toBe(true);
  expect(cursorAuthenticated('{"status":"partially-authenticated","isAuthenticated":false,"hasAccessToken":true}')).toBe(false);
  expect(cursorAuthenticated('{"status":"unauthenticated","isAuthenticated":false}')).toBe(false);
  expect(cursorAuthenticated('{"status":"error","message":"Could not check"}')).toBeNull();
  expect(cursorAuthenticated("Unexpected output")).toBeNull();
});
