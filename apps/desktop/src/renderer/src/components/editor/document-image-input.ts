import type { Editor } from "@tiptap/react";
import { IMAGE_ACCEPT } from "../../lib/image-imports";

/** A shared document cannot import an image into this device's private attachment store. */
export function documentImageInput(
  editor: Editor | null,
  disabled: boolean,
  unavailable: string | undefined,
  stage: (editor: Editor, files: File[], position?: number) => void,
  close: () => void,
  report: (message: string) => void,
) {
  const add = (files: File[], position?: number) => {
    if (!editor || disabled) return;
    if (unavailable) {
      report(unavailable);
      return;
    }
    report("");
    close();
    stage(editor, files, position);
  };
  const pick = () => {
    if (unavailable) {
      report(unavailable);
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = IMAGE_ACCEPT;
    input.multiple = true;
    input.onchange = () => add(Array.from(input.files ?? []));
    input.click();
  };
  return { add, pick };
}
