/** A path with the person's home folder as `~`, as they read it: under /Users, /home or C:\Users. */
export const homeRelative = (path: string): string => path.replace(/^(?:\/(?:Users|home)\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/]|$)/, "~");
