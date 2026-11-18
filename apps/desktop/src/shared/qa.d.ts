/** True in development and QA builds, which carry the test switches; false in release and local packages. Set by electron.vite.config.ts. */
declare const __OPENORC_QA__: boolean;
/** The OpenOrc Cloud server this build was given when it was built, or empty. Set by electron.vite.config.ts for the main and core bundles. */
declare const __OPENORC_ACCOUNT_SERVER__: string;
