import { createContext, useContext } from "react";

/**
 * The Mac cannot reach OpenOrc Cloud now, as Home last heard: its cloud rows are what it last heard, and their cloud
 * dims. A row's own reach can lag behind, as Home's lists read again only now and then.
 */
export const CloudOutOfReach = createContext(false);

export const useCloudOutOfReach = (): boolean => useContext(CloudOutOfReach);
