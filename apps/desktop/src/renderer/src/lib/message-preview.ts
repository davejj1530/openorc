import { Lexer, type MarkedToken, type Token } from "marked";

/** A message as a list shows it: its words on one line, without Markdown's marks or raw HTML. */
export function messagePreview(markdown: string): string {
  return blockText(new Lexer().lex(markdown)).replace(/\s+/g, " ").trim();
}

/** Blocks read one after another: paragraphs, headings, list items, table cells and code as written. */
function blockText(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      const block = token as MarkedToken;
      switch (block.type) {
        case "paragraph":
        case "heading":
          return inlineText(block.tokens);
        case "text":
          return block.tokens ? inlineText(block.tokens) : block.text;
        case "blockquote":
          return blockText(block.tokens);
        case "list":
          return block.items.map((item) => blockText(item.tokens)).join(" ");
        case "table":
          return [block.header, ...block.rows]
            .flat()
            .map((cell) => inlineText(cell.tokens))
            .join(" ");
        case "code":
          return block.text;
        default:
          return "";
      }
    })
    .join(" ");
}

/** Inline runs carry their own spacing; bold, links and the like keep only their words, and an image its alt text. */
function inlineText(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      const inline = token as MarkedToken;
      switch (inline.type) {
        case "strong":
        case "em":
        case "del":
        case "link":
          return inlineText(inline.tokens);
        case "text":
          return inline.tokens ? inlineText(inline.tokens) : inline.text;
        case "codespan":
        case "escape":
        case "image":
          return inline.text;
        case "br":
          return " ";
        default:
          return "";
      }
    })
    .join("");
}
