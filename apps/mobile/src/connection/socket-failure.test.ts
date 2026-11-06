import { expect, it } from "vitest";
import { answeredStatus } from "./socket-failure";

it("reads the status an address answered a link's upgrade with, as iOS and Android word it", () => {
  expect(answeredStatus("Received bad response code from server: 502.")).toBe(502);
  expect(answeredStatus("Expected HTTP 101 response but was '503 Service Unavailable'")).toBe(503);
  expect(answeredStatus("The operation couldn’t be completed. Connection refused")).toBeNull();
  expect(answeredStatus(undefined)).toBeNull();
});
