import { expect, it } from "vitest";
import { codePathHref } from "./code-path-links";

it.each([
  ["src/app.ts", "src/app.ts"],
  ["apps/desktop/src/renderer/src/components/Composer.tsx:42", "apps/desktop/src/renderer/src/components/Composer.tsx#L42"],
  ["src/app.ts:42:7", "src/app.ts#L42"],
  ["src/app.ts:42-50", "src/app.ts#L42-L50"],
  ["src/app.ts#L12-L20", "src/app.ts#L12-L20"],
  ["./lib/util.js", "./lib/util.js"],
  [".github/workflows/ci.yml", ".github/workflows/ci.yml"],
  ["config/.env.local", "config/.env.local"],
  ["app/[id]/page.tsx", "app/%5Bid%5D/page.tsx"],
  ["docs/100%.md", "docs/100%25.md"],
  ["/home/me/repo/src/app.ts:3", "/home/me/repo/src/app.ts#L3"],
  ["C:\\repo\\src\\app.ts", "C%3A%5Crepo%5Csrc%5Capp.ts"],
  ["  src/app.ts  ", "src/app.ts"],
  ["Contoso.Web/Controllers/HomeController.cs", "Contoso.Web/Controllers/HomeController.cs"],
  ["chart.js/dist/chart.umd.js", "chart.js/dist/chart.umd.js"],
  ["image/logo.png", "image/logo.png"],
])("links %j as %j", (code, href) => {
  expect(codePathHref(code)).toBe(href);
});

it.each([
  "app.ts",
  "useLayout.getState",
  "useLayout.getState()",
  "src/components/",
  "@openorc/protocol",
  "text/plain",
  "and/or",
  "v1/2.0",
  "https://example.com/app.js",
  "localhost:3000/api/data.json",
  "github.com/owner/repo.git",
  "example.com/docs/index.html",
  "www.example.org/a.html",
  "docs.rs/serde/latest/serde.html",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "src/**/*.ts",
  "$HOME/.config/app.json",
  "~/.claude/settings.json",
  "~ada/notes/todo.md",
  "pnpm --filter ./apps/desktop typecheck",
  "const a = b/c.d",
  "",
])("leaves %j alone", (code) => {
  expect(codePathHref(code)).toBeNull();
});
