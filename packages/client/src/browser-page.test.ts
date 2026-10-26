import { describe, expect, it } from "vitest";
import { pageHost, pageLabel, publicAddress } from "./browser-page.js";

describe("a page's host and label", () => {
  it("names a page by its host, keeping a port that is not the scheme's own", () => {
    expect(pageHost("http://127.0.0.1:47831/tick?ms=250")).toBe("127.0.0.1:47831");
    expect(pageHost("https://example.com:443/a")).toBe("example.com");
    expect(pageHost("http://[::1]:5173/")).toBe("[::1]:5173");
    expect(pageHost("about:blank")).toBe("about:blank");
    expect(pageHost("not a url")).toBe("not a url");
  });

  it("labels a page by its title, else its host, else Preview", () => {
    expect(pageLabel({ url: "http://127.0.0.1:47831/", title: "QA Page" })).toBe("QA Page");
    expect(pageLabel({ url: "http://127.0.0.1:47831/hangup", title: "" })).toBe("127.0.0.1:47831");
    expect(pageLabel({ url: "", title: "" })).toBe("Preview");
  });
});

describe("a public address", () => {
  it("is a web address on a dotted public name or address", () => {
    for (const url of ["https://example.com/docs", "http://app.example.co.uk:8080/a?b=1", "https://8.8.8.8/", "https://[2606:4700::1111]/"]) expect(publicAddress(url), url).toBe(true);
  });

  it("is never the Mac's own or its network's, which on a phone would be the phone's", () => {
    for (const url of [
      "http://localhost:5173/",
      "http://app.localhost/",
      "http://mac.local:3000/",
      "http://service.internal/",
      "https://mac.tail1234.ts.net/",
      "http://127.0.0.1:47831/",
      "http://127.8.9.10/",
      "http://10.0.0.5/",
      "http://172.16.4.2/",
      "http://172.31.255.255/",
      "http://192.168.68.53:8080/",
      "http://169.254.1.1/",
      "http://100.64.0.1/",
      "http://100.127.255.255/",
      "http://0.0.0.0:3000/",
      "http://[::1]:5173/",
      "http://[fd7a:115c:a1e0::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:192.168.1.2]/",
      "http://devbox:3000/",
    ])
      expect(publicAddress(url), url).toBe(false);
  });

  it("is only http or https", () => {
    for (const url of ["ftp://example.com/", "about:blank", "file:///etc/hosts", "javascript:alert(1)", "example.com", ""]) expect(publicAddress(url), url).toBe(false);
    expect(publicAddress("http://172.32.0.1/")).toBe(true);
    expect(publicAddress("http://100.128.0.1/")).toBe(true);
  });
});
