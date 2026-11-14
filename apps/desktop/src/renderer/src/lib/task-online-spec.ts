import { marked } from "marked";

function sharedImage(address: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(address).protocol);
  } catch {
    return false;
  }
}

/** Parse Markdown so a code example describing a local path is still ordinary text. */
export function validateOnlineTaskSpec(spec: string | null | undefined): void {
  if (!spec) return;
  let privateImage = false;
  void marked.walkTokens(marked.lexer(spec), (token) => {
    if (token.type === "image" && !sharedImage(token.href)) privateImage = true;
    if (token.type === "html") {
      const html = new DOMParser().parseFromString(token.text, "text/html");
      for (const image of html.querySelectorAll("img")) if (!sharedImage(image.getAttribute("src") ?? "")) privateImage = true;
    }
  });
  if (privateImage) throw new Error("This image is only on this device. Remove it before saving the shared task.");
}
