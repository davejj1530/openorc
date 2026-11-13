import { useEffect } from "react";
import { mergeRegister } from "lexical";
import { useEditor } from "../editor";
import { ConnectorNode, FileNode, MemberNode } from "../nodes";
import { PICKED } from "../shared";

/**
 * A pill picked from a list lands with one pop. Only a pill created by a pick's own update does: one that comes from
 * typing, a paste, an undo or a draft coming back keeps still. The pop is the mark's element carrying `data-landing`
 * until its animation ends.
 */
export function LandingPlugin() {
  const editor = useEditor();
  useEffect(() => {
    const land = (mutations: Map<string, string>, { updateTags }: { updateTags: Set<string> }) => {
      if (!updateTags.has(PICKED)) return;
      for (const [key, mutation] of mutations) {
        const element = mutation === "created" ? editor.getElementByKey(key) : null;
        if (!element) continue;
        element.dataset["landing"] = "";
        element.addEventListener("animationend", () => delete element.dataset["landing"], { once: true });
      }
    };
    return mergeRegister(...[ConnectorNode, MemberNode, FileNode].map((klass) => editor.registerMutationListener(klass, land, { skipInitialization: true })));
  }, [editor]);
  return null;
}
