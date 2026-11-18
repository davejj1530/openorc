import { expect, it } from "vitest";
import { accountServerAt, builtAccountServer } from "./account-server";

const SERVER = "https://cloud.example.test";
const OTHER = "http://localhost:3517";
const noFile = () => ({});
const file = () => ({ OPENORC_ACCOUNT_SERVER: OTHER });

it("builds in the server the build's environment names, in a release as in development", () => {
  expect(builtAccountServer("production", { OPENORC_ACCOUNT_SERVER: SERVER }, noFile)).toBe(SERVER);
  expect(builtAccountServer("development", { OPENORC_ACCOUNT_SERVER: SERVER }, file)).toBe(SERVER);
});

it("reads the local file only for a development build, and builds a release given none with no server", () => {
  expect(builtAccountServer("development", {}, file)).toBe(OTHER);
  expect(builtAccountServer("production", {}, file)).toBe("");
  expect(builtAccountServer("production", { OPENORC_ACCOUNT_SERVER: "" }, noFile)).toBe("");
});

it("signs in to the built-in server, or to one named at launch only in a development or QA build", () => {
  expect(accountServerAt(SERVER, false, {})).toBe(SERVER);
  expect(accountServerAt(SERVER, false, { OPENORC_ACCOUNT_SERVER: OTHER })).toBe(SERVER);
  expect(accountServerAt(SERVER, true, { OPENORC_ACCOUNT_SERVER: OTHER })).toBe(OTHER);
  expect(accountServerAt("", true, {})).toBeUndefined();
  expect(accountServerAt("", false, { OPENORC_ACCOUNT_SERVER: OTHER })).toBeUndefined();
});
