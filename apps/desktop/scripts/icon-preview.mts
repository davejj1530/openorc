import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as icons from "../src/renderer/src/components/icons";

const out = resolve(import.meta.dirname, "../../../output/icons");
await mkdir(resolve(out, "svg"), { recursive: true });
const entries = Object.entries(icons)
  .filter(([name]) => name !== "default" && name !== "module.exports")
  .sort(([a], [b]) => a.localeCompare(b));
const cells = await Promise.all(
  entries.map(async ([name, Icon]) => {
    const svg = renderToStaticMarkup(createElement(Icon, { size: 24 }));
    await writeFile(resolve(out, "svg", `${name}.svg`), svg);
    return `<article><div class="specimen">${renderToStaticMarkup(createElement(Icon, { size: 36 }))}</div><p>${name}</p><div class="sizes">${[12, 16, 20, 24].map((size) => `<span>${renderToStaticMarkup(createElement(Icon, { size }))}<small>${size}</small></span>`).join("")}</div></article>`;
  }),
);
await writeFile(
  resolve(out, "precision-outline.html"),
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenOrc — Precision Outline</title><style>
*{box-sizing:border-box}body{margin:0;padding:40px;font:14px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:#f8f8f8;color:#242428}body.dark{background:#191919;color:#ececee}header{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:32px}h1{font-size:28px;letter-spacing:-.025em;margin:0 0 10px}header p{margin:0;opacity:.65}button{font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:7px;padding:8px 12px;cursor:pointer}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:0}article{padding:22px 8px;text-align:center;border-bottom:1px solid #8883}.specimen{height:48px;display:grid;place-items:center}article p{font-size:12px;margin:12px 0 18px}.sizes{display:flex;align-items:start;justify-content:center;gap:15px}.sizes span{display:flex;align-items:center;flex-direction:column;gap:10px}.sizes svg{height:24px}.sizes small{font-size:10px;opacity:.5}@media(max-width:700px){body{padding:20px}header{align-items:start}h1{font-size:22px}}
</style><header><div><h1>OpenOrc / Precision Outline</h1><p>${entries.length} Codex-generated icons · 24-unit grid · 1.75 stroke · actual SVG components</p></div><button onclick="document.body.classList.toggle('dark')" aria-label="Toggle light and dark preview">Light / Dark</button></header><main>${cells.join("")}</main></html>`,
);
console.log(JSON.stringify({ icons: entries.length, preview: resolve(out, "precision-outline.html") }));

if (!process.argv.includes("--preview-only")) {
  // The diff renderer exposes SVG symbols rather than React icon slots.
  const diffIcons = {
    "arrow-right-short": icons.ArrowRight,
    "brand-github": icons.GitPullRequest,
    chevron: icons.ChevronDown,
    "chevrons-narrow": icons.ChevronsUpDown,
    "diff-split": icons.Columns2,
    "diff-unified": icons.FileDiff,
    expand: icons.ChevronDown,
    "expand-all": icons.ChevronsUpDown,
    "file-code": icons.FileCode2,
    plus: icons.Plus,
    "symbol-added": icons.SquarePlus,
    "symbol-deleted": icons.SquareMinus,
    "symbol-diffstat": icons.FileDiff,
    "symbol-ignored": icons.SquareSlash,
    "symbol-modified": icons.SquareDot,
    "symbol-moved": icons.ArrowRight,
    "symbol-ref": icons.PanelLeft,
  };
  const symbols = Object.entries(diffIcons).map(([name, Icon]) => {
    const svg = renderToStaticMarkup(createElement(Icon));
    return `<symbol id="diffs-icon-${name}" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")}</g></symbol>`;
  });
  await writeFile(resolve(import.meta.dirname, "../src/renderer/src/components/icons-diff.svg"), `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join("")}</svg>\n`);
  await writeFile(resolve(import.meta.dirname, "../src/renderer/src/components/icons-select.svg"), renderToStaticMarkup(createElement(icons.ChevronDown, { size: 14, stroke: "#777777" })) + "\n");
}
