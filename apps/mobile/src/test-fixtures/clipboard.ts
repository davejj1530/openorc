/** The pasteboard in tests: what the app copied, newest last, and what a paste reads. */
export const copied: string[] = [];
export const pasteboard = { text: "" };
export const setStringAsync = (text: string) => Promise.resolve(Boolean(copied.push(text)));
export const getStringAsync = () => Promise.resolve(pasteboard.text);
export const isPasteButtonAvailable = false;
export const ClipboardPasteButton = () => null;
