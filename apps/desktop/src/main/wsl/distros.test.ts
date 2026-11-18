import { describe, expect, it } from "vitest";
import { decodeWslText } from "./distro";
import { listDistros, parseDistros } from "./distros";

const utf16 = (text: string) => Buffer.from(text, "utf16le");

describe("WSL distributions", () => {
  it("reads wsl.exe's text whether it wrote UTF-16 or UTF-8", () => {
    expect(decodeWslText(utf16("Ubuntu\r\nDebian\r\n"))).toBe("Ubuntu\nDebian\n");
    expect(decodeWslText(Buffer.from("Ubuntu\r\nDebian\r\n", "utf8"))).toBe("Ubuntu\nDebian\n");
    expect(decodeWslText(utf16("\uFEFFUbuntu\r\n"))).toBe("Ubuntu\n");
    expect(decodeWslText(Buffer.alloc(0))).toBe("");
  });

  it("finds the default and each version by the distribution's name", () => {
    const verbose = [
      "  NAME                   STATE           VERSION",
      "* Ubuntu                 Running         2",
      "  Debian                 Stopped         1",
      "  docker-desktop         Stopped         2",
    ].join("\n");
    expect(parseDistros("Ubuntu\nDebian\ndocker-desktop\n", verbose)).toEqual([
      { name: "Ubuntu", default: true, version: 2 },
      { name: "Debian", default: false, version: 1 },
    ]);
  });

  it("reads a listing whose heading and states are translated", () => {
    const verbose = ["  NAME      STATUS            VERSION", "* Ubuntu    Wird ausgeführt   2", "  Fedora    Beendet           2"].join("\n");
    expect(parseDistros("Ubuntu\nFedora\n", verbose)).toEqual([
      { name: "Ubuntu", default: true, version: 2 },
      { name: "Fedora", default: false, version: 2 },
    ]);
  });

  it("offers the names alone when there is no verbose listing", () => {
    expect(parseDistros("Ubuntu\n", "")).toEqual([{ name: "Ubuntu", default: false, version: null }]);
  });

  it("lists the default first, from what wsl.exe wrote", async () => {
    const run = async (args: string[]) => utf16(args.includes("--quiet") ? "Debian\r\nUbuntu\r\n" : "  NAME    STATE    VERSION\r\n  Debian  Stopped  2\r\n* Ubuntu  Running  2\r\n");
    expect((await listDistros("win32", run)).map((distro) => distro.name)).toEqual(["Ubuntu", "Debian"]);
  });

  it("lists nothing off Windows, or when wsl.exe is missing or has nothing installed", async () => {
    const never = async (): Promise<Buffer> => {
      throw new Error("must not run");
    };
    expect(await listDistros("darwin", never)).toEqual([]);
    expect(await listDistros("linux", never)).toEqual([]);
    expect(await listDistros("win32", async () => Promise.reject(new Error("ENOENT")))).toEqual([]);
  });

  it("still lists by name when only the verbose listing fails", async () => {
    const run = async (args: string[]) => (args.includes("--quiet") ? utf16("Ubuntu\r\n") : Promise.reject(new Error("unknown option")));
    expect(await listDistros("win32", run)).toEqual([{ name: "Ubuntu", default: false, version: null }]);
  });
});
