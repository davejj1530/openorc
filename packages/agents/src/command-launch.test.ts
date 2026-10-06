import { expect, it } from "vitest";
import { launchCommand } from "./command-launch.js";

const comspec = "C:\\Windows\\system32\\cmd.exe";

it("runs programs as given, and Windows executables without a shell", () => {
  expect(launchCommand("/usr/local/bin/codex", ["app-server"], "darwin")).toEqual({ file: "/usr/local/bin/codex", args: ["app-server"], options: { windowsHide: true } });
  expect(launchCommand("C:\\bin\\claude.exe", ["-p"], "win32", comspec)).toEqual({ file: "C:\\bin\\claude.exe", args: ["-p"], options: { windowsHide: true } });
});

it("starts an npm launcher through cmd.exe with every argument quoted and escaped twice", () => {
  const launch = launchCommand("C:\\Users\\Jo Doe\\npm\\codex.cmd", ["app-server", '{"a":1}', "a&b", "100%"], "win32", comspec);
  expect(launch.file).toBe(comspec);
  expect(launch.options).toEqual({ windowsHide: true, windowsVerbatimArguments: true });
  expect(launch.args).toEqual(["/d", "/s", "/c", '"C:\\Users\\Jo^ Doe\\npm\\codex.cmd ^^^"app-server^^^" ^^^"{\\^^^"a\\^^^":1}^^^" ^^^"a^^^&b^^^" ^^^"100^^^%^^^""']);
});

it("doubles backslashes only where they come before a quote", () => {
  const [, , , line] = launchCommand("x.bat", ["C:\\dir\\", 'say \\"hi'], "win32", comspec).args;
  expect(line).toBe('"x.bat ^^^"C:\\dir\\\\^^^" ^^^"say^^^ \\\\\\^^^"hi^^^""');
});

it("refuses a line break, which would end the command cmd.exe runs", () => {
  expect(() => launchCommand("codex.cmd", ["one\ntwo"], "win32", comspec)).toThrow(/line break/);
});
