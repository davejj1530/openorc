import { expect, it } from "vitest";
import { urlHost } from "./url-host.js";

it("reads hosts the way a browser's URL does for the addresses fetch labels show", () => {
  // Expected values are what WHATWG URL gives for the same input.
  const cases: [string, { host: string; hostname: string } | null][] = [
    ["https://www.example.com/docs?q=1#top", { host: "www.example.com", hostname: "www.example.com" }],
    ["HTTPS://WWW.Example.COM/", { host: "www.example.com", hostname: "www.example.com" }],
    ["http://localhost:5173/app", { host: "localhost:5173", hostname: "localhost" }],
    ["https://example.com:443/x", { host: "example.com", hostname: "example.com" }],
    ["http://127.0.0.1:80/x", { host: "127.0.0.1", hostname: "127.0.0.1" }],
    ["https://example.com:0080/", { host: "example.com:80", hostname: "example.com" }],
    ["https://user:pass@example.com:9000/p", { host: "example.com:9000", hostname: "example.com" }],
    ["http://[::1]:3000/", { host: "[::1]:3000", hostname: "[::1]" }],
    ["https://exa mple.com", null],
    ["https://", null],
    ["example.com", null],
  ];
  for (const [input, expected] of cases) expect([input, urlHost(input)]).toEqual([input, expected]);
});
