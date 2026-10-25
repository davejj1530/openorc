import { createClientState, type RpcQueryOptions } from "@openorc/client";
import type { AssetRef, RemoteMethod, RpcParams, RpcResults } from "@openorc/protocol";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import Constants from "expo-constants";
import { addNetworkStateListener, getNetworkStateAsync, NetworkStateType, type NetworkState } from "expo-network";
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { createMMKV } from "react-native-mmkv";
import { randomUUID } from "react-native-quick-crypto";
import { createAssetCache } from "./connection/asset-cache";
import { linkHooks } from "./connection/link-hooks";
import { ConnectionManager, type LinkState } from "./connection/manager";
import { keychainKeys, openSocket, phoneCrypto, reachesInternet, storedMacs, systemClock } from "./connection/native";
import type { NetworkKind, SavedMac } from "./connection/saved-macs";
import { forgetFolds } from "./home/fold-keys";
import { forgetLists, keepLists, restoreLists } from "./lists-cache";
import { followMacLook } from "./look/look";
import { PhoneAlerts } from "./notifications/alerts";
import { presentationFor } from "./notifications/foreground";
import { handleAlerts, pushPlatform } from "./notifications/native";
import { threadOnScreen } from "./notifications/on-screen";
import { timeFrame } from "./thread/perf-probe";

/** The app's own key-value store: saved Macs, lists Home paints from on a cold start, drafts. */
export const storage = createMMKV({ id: "openorc" });

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
    forgetFolds(storage, macId);
    assets.forget(macId);
  },
  reachesInternet,
});

/** Client state over the link, built like the desktop's: same tags, same transcript reducer, another connection. */
export const client = createClientState(link.connection, {
  scheduleFrame: (callback) => requestAnimationFrame(timeFrame(callback)),
  // Every refetch is a trip over the network, and agents push "threads" about once a second while they work.
  invalidationBatchMs: 250,
  randomId: () => randomUUID(),
  // A phone may not change the Mac's app settings: a permission chosen here stays with its thread.
  savesDefaultPermission: false,
});

/** Which alerts this phone wants from each Mac, told to the shown one on every session and at once on a change. */
export const alerts = new PhoneAlerts({ link, platform: pushPlatform, storage });

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

// Before the link starts, so the look kept for the shown Mac paints before the first frame.
followMacLook(client.queryClient.getQueryCache());
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
alerts.start();
handleAlerts((data) => presentationFor(data, link.getState(), threadOnScreen()));
void getNetworkStateAsync().then((state) => link.setNetwork(networkKind(state)));
addNetworkStateListener((state) => link.setNetwork(networkKind(state)));
AppState.addEventListener("change", (state) => {
  link.appState(state === "background" ? "background" : "active");
  // iOS Settings may have changed alerts while the app was away.
  if (state === "active") void alerts.refresh();
});

/** The Mac this phone shows, or null while none is paired. */
export const shownMacId = (): string | null => shownMac;

export function useLinkState(): LinkState {
  return useSyncExternalStore(link.subscribe, link.getState);
}

/** The Macs this phone paired with, as the list changes. */
export function useSavedMacs(): readonly SavedMac[] {
  return useSyncExternalStore(link.subscribe, link.getMacs);
}

export const { useSession, useLinkRead } = linkHooks(link);

/** A `file://` URI for an image the shown Mac's transcript names. */
export function assetUri(ref: AssetRef): Promise<string> {
  if (!shownMac) return Promise.reject(new Error("This phone is not connected to a Mac."));
  return assets.uri(shownMac, ref);
}

// The phone may call only what phone access allows; these narrow the shared hooks so anything else does not compile.
export const useRpc: <M extends RemoteMethod>(method: M, params: RpcParams<M>, options?: RpcQueryOptions<M>) => UseQueryResult<RpcResults[M]> = client.useRpc;
export const useRpcs: <M extends RemoteMethod>(method: M, paramsList: readonly RpcParams<M>[], options?: RpcQueryOptions<M>) => UseQueryResult<RpcResults[M]>[] = client.useRpcs;
export const useRpcMutation: <M extends RemoteMethod>(method: M) => UseMutationResult<RpcResults[M], Error, RpcParams<M>> = client.useRpcMutation;
export const { queryClient, useRun } = client;
