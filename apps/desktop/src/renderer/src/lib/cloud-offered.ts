/** Cloud threads are offered in development and QA builds until they ship. */
export const cloudOffered = import.meta.env.DEV || __OPENORC_QA__;
