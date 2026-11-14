/** True in development and QA builds, which carry the test switches; false in release and local packages. Set by electron.vite.config.ts. */
declare const __OPENORC_QA__: boolean;
/** The OpenOrc server a development build signs in to, or empty; empty in every other build. Set by electron.vite.config.ts for the main and core bundles. */
declare const __OPENORC_DEV_ACCOUNT_SERVER__: string;
