// Browsers, React Native and Node all have timers, but no lib without the DOM declares them.
declare function setTimeout(callback: (...args: never[]) => void, ms?: number): unknown;
declare function clearTimeout(handle: unknown): void;
declare function setInterval(callback: (...args: never[]) => void, ms?: number): unknown;
declare function clearInterval(handle: unknown): void;
