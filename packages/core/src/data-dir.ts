import path from "node:path";

/** OpenOrc's database, which holds every account's conversations. */
export const DATABASE_FILE = "openorc.sqlite";

/** The database and the files SQLite keeps beside it while it's open. */
export const DATABASE_FILES = ["", "-wal", "-shm"].map((suffix) => `${DATABASE_FILE}${suffix}`);

/** Where each provider's events are logged as they arrive, every account's finished messages and tool results among them. */
export const PROVIDER_LOGS = path.join("logs", "provider");
