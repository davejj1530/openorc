import { createClientState, type RpcQueryOptions } from "@openorc/client";
import type { AssetRef, RemoteMethod, RpcParams, RpcResults } from "@openorc/protocol";
import type { UseQueryResult } from "@tanstack/react-query";
import Constants from "expo-constants";
import { addNetworkStateListener, getNetworkStateAsync, NetworkStateType, type NetworkState } from "expo-network";
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { createMMKV } from "react-native-mmkv";
import { randomUUID } from "react-native-quick-crypto";
import { createAssetCache } from "./connection/asset-cache";
import { ConnectionManager, type LinkState } from "./connection/manager";
import { keychainKeys, openSocket, phoneCrypto, storedMacs, systemClock } from "./connection/native";
import type { NetworkKind } from "./connection/saved-macs";
import { forgetLists, keepLists, restoreLists } from "./lists-cache";

const storage = createMMKV({ id: "openorc" });

/** The phone's one connection to its Macs. Created at load, so the route race starts while React mounts. */
export const link = new ConnectionManager({
  openSocket,
  crypto: phoneCrypto,
  clock: systemClock,
  random: Math.random,
  macs: storedMacs(storage),
  keys: keychainKeys,
  deviceName: Constants.deviceName ?? "iPhone",
  forgetCache: (macId) => {
    forgetLists(storage, macId);
    assets.forget(macId);
  },
});

/** Client state over the link, built like the desktop's: same tags, same transcript reducer, another connection. */
export const client = createClientState(link.connection, {
  scheduleFrame: (callback) => requestAnimationFrame(callback),
  // Every refetch is a trip over the network, and agents push "threads" about once a second while they work.
  invalidationBatchMs: 250,
  randomId: () => randomUUID(),
});

const assets = createAssetCache((ref) => link.connection.asset(ref), phoneCrypto.sha256);

const macOf = (state: LinkState) => (state.kind === "unpaired" ? null : state.mac.id);
let shownMac: string | null = null;

/** Data never mixes between Macs: another Mac starts from its own saved lists, or from nothing. */
function show(macId: string | null): void {
  if (macId === shownMac) return;
  shownMac = macId;
  client.queryClient.clear();
  client.runs.reset();
  link.connection.reset(macId !== null && restoreLists(client.queryClient, storage, macId));
}

link.subscribe(() => show(macOf(link.getState())));
keepLists(client.queryClient, storage, () => shownMac);

const networkKinds: Partial<Record<NetworkStateType, NetworkKind>> = {
  [NetworkStateType.WIFI]: "wifi",
  [NetworkStateType.ETHERNET]: "wifi",
  [NetworkStateType.CELLULAR]: "cellular",
  [NetworkStateType.NONE]: "none",
};
const networkKind = (state: NetworkState): NetworkKind => (state.isConnected === false ? "none" : (networkKinds[state.type ?? NetworkStateType.UNKNOWN] ?? "other"));

link.start("other");
void getNetworkStateAsync().then((state) => link.setNetwork(networkKind(state)));
addNetworkStateListener((state) => link.setNetwork(networkKind(state)));
AppState.addEventListener("change", (state) => link.appState(state === "background" ? "background" : "active"));

export function useLinkState(): LinkState {
  return useSyncExternalStore(link.subscribe, link.getState);
}

/** A `file://` URI for an image the shown Mac's transcript names. */
export function assetUri(ref: AssetRef): Promise<string> {
  if (!shownMac) return Promise.reject(new Error("This phone is not connected to a Mac."));
  return assets.uri(shownMac, ref);
}

// The phone may call only what phone access allows; these narrow the shared hooks so anything else does not compile.
export const useRpc: <M extends RemoteMethod>(method: M, params: RpcParams<M>, options?: RpcQueryOptions<M>) => UseQueryResult<RpcResults[M]> = client.useRpc;
export const useRpcs: <M extends RemoteMethod>(method: M, paramsList: readonly RpcParams<M>[], options?: RpcQueryOptions<M>) => UseQueryResult<RpcResults[M]>[] = client.useRpcs;
export const { queryClient, useRun } = client;
