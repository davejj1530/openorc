/** Worklets in tests run where they are called. */
export const scheduleOnRN = <A extends unknown[]>(callback: (...args: A) => void, ...args: A) => callback(...args);
