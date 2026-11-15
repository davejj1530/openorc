import { createClientState, type RpcQueryOptions } from "@openorc/client";
import type { AssetRef, CloudRemoteMethod, RemoteMethod, RpcParams, RpcResults } from "@openorc/protocol";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import Constants from "expo-constants";
import { addNetworkStateListener, getNetworkStateAsync, NetworkStateType, type NetworkState } from "expo-network";
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { createMMKV } from "react-native-mmkv";
import { randomUUID } from "react-native-quick-crypto";
import { createAssetCache } from "./connection/asset-cache";
import { linkHooks } from "./connection/link-hooks";
import { forgetRemovedBrains, macsOnly, namedBrain } from "./connection/hosts";
import { ConnectionManager, showsDemo, type LinkState } from "./connection/manager";
import { forgetDoorKey, keychainKeys, openSocket, phoneCrypto, reachesInternet, storedMacs, systemClock } from "./connection/native";
import type { NetworkKind, SavedMac } from "./connection/saved-macs";
import { createDemoMac, DEMO_MAC } from "./demo/demo-mac";
import { forgetFolds } from "./home/fold-keys";
import { spaceKey } from "./spaces/space-key";
import { forgetLists, keepLists, restoreLists } from "./lists-cache";
import { followMacLook } from "./look/look";
import { PhoneAlerts } from "./notifications/alerts";
import { oncePerNotice, presentationFor } from "./notifications/foreground";
import { handleAlerts, pushPlatform } from "./notifications/native";
import { threadOnScreen } from "./notifications/on-screen";
import { ScratchStore } from "./scratch-store";
import { timeFrame } from "./thread/perf-probe";

/** The app's own key-value store on disk. Only saved Macs use it directly; the demo never touches them. */
const kept = createMMKV({ id: "openorc" });

/** What the app keeps (lists Home paints from on a cold start, folds, drafts, settings), scratched while the demo shows. */
export const storage = new ScratchStore(kept);

/** Every saved host, a cloud brain an earlier build paired included; the link sees the Macs among them. */
const hosts = storedMacs(kept);
const macs = macsOnly(hosts);

/** The phone's connection to the Mac it shows. Created at load, so the route race starts while React mounts. */
export const link = new ConnectionManager({
  openSocket,
  crypto: phoneCrypto,
  clock: systemClock,
  random: Math.random,
  keys: keychainKeys,
  deviceName: Constants.deviceName ?? "iPhone",
  reachesInternet,
  forgetDoorKey,
  brainsRemoved: forgetRemovedBrains(hosts, (id) => void link.forget(id)),
  macs,
  forgetCache: (macId) => {
    forgetLists(storage, macId);
    forgetFolds(storage, macId);
    storage.remove(spaceKey(macId));
    assets.forget(macId);
  },
});

/** Client state over the link, built like the desktop's: same tags, same transcript reducer, another connection. */
export const client = createClientState(link.connection, {
  scheduleFrame: (callback) => requestAnimationFrame(timeFrame(callback)),
  // Every refetch is a trip over the network, and agents push "threads" about once a second while they work.
  invalidationBatchMs: 250,
  randomId: () => randomUUID(),
  // A phone may not change the Mac's app settings: a permission chosen here stays with its thread.
  savesDefaultPermission: false,
  reportFrameError: (frame, error) => console.warn("[OpenOrc] Dropped incoming frame", { runId: frame.runId, seq: frame.seq, error: error instanceof Error ? error.name : "Error" }),
});

/** Which alerts this phone wants from each Mac, told to the shown one on every session and at once on a change. */
export const alerts = new PhoneAlerts({ link, platform: pushPlatform, storage });

const assets = createAssetCache((ref) => link.connection.asset(ref), phoneCrypto.sha256);

const macOf = (state: LinkState) => (state.kind === "unpaired" ? null : state.mac.id);
let shownMac: string | null = null;

/** Data never mixes between Macs: another Mac starts from its own saved lists, or from nothing; the demo keeps none. */
function show(macId: string | null): void {
  if (macId === shownMac) return;
  shownMac = macId;
  storage.scratch(macId === DEMO_MAC.id);
  client.queryClient.clear();
  client.runs.reset();
  link.connection.reset(macId !== null && restoreLists(client.queryClient, storage, macId));
}

// Before the link starts, so the look kept for the shown Mac paints before the first frame.
followMacLook(client.queryClient.getQueryCache());
// The link's first listener: what the others ask of the shown Mac must go over its own connection. Behind them, a Mac
// paired anew would be asked over the session of the one before it, or the call dropped as that session is let go.
link.subscribe(() => show(macOf(link.getState())));
keepLists(client.queryClient, storage, () => shownMac);

/**
 * An earlier build paired a Mac's cloud brain as a second host, on the Mac's word in this answer. The word is still kept
 * on the Mac's record, and cleared once the Mac names none: it is how the phone knows whose brain a saved one is when a
 * Mac says it removed it. A Mac that does not take the question answers with an error, which changes nothing.
 */
let heardFrom = 0;
link.subscribe(() => {
  const state = link.getState();
  if (state.kind !== "connected" || state.serial === heardFrom) return;
  heardFrom = state.serial;
  void link.connection
    .call("cloud.offer", {})
    .then((offer) => namedBrain(macs, state.mac.id, offer.brain?.host ?? null))
    .catch(() => undefined);
});

const networkKinds: Partial<Record<NetworkStateType, NetworkKind>> = {
  [NetworkStateType.WIFI]: "wifi",
  [NetworkStateType.ETHERNET]: "wifi",
  [NetworkStateType.CELLULAR]: "cellular",
  [NetworkStateType.NONE]: "none",
};
const networkKind = (state: NetworkState): NetworkKind => (state.isConnected === false ? "none" : (networkKinds[state.type ?? NetworkStateType.UNKNOWN] ?? "other"));

/** The demo Mac in place of none, fresh each time. */
export const showDemo = (): void => link.showDemo(createDemoMac(systemClock));
/** Back to no Mac, as a fresh install has. */
export const endDemo = (): void => link.endDemo();

// However the demo ends (End demo, Skip, or a pairing from inside it), the images it served go with it.
let demoShown = false;
link.subscribe(() => {
  const shown = showsDemo(link.getState());
  if (demoShown && !shown) assets.forget(DEMO_MAC.id);
  demoShown = shown;
});

link.start("other");
// A first launch, or any launch with no Mac paired, opens on the demo; Skip is in reach from its first frame.
showDemo();
alerts.start();
handleAlerts(oncePerNotice((data) => presentationFor(data, link.getState(), threadOnScreen())));
void getNetworkStateAsync().then((state) => link.setNetwork(networkKind(state)));
addNetworkStateListener((state) => link.setNetwork(networkKind(state)));
AppState.addEventListener("change", (state) => {
  link.appState(state === "background" ? "background" : "active");
  // iOS Settings may have changed alerts while the app was away.
  if (state === "active") void alerts.refresh();
});

/** The Mac this phone shows, or null while none is paired. */
export const shownMacId = (): string | null => shownMac;

/** The link to the shown Mac, as it changes. */
export const useLinkState = (): LinkState => useSyncExternalStore(link.subscribe, link.getState);

/** The Macs this phone paired with, as the link saves one. */
export const useSavedMacs = (): readonly SavedMac[] => useSyncExternalStore(link.subscribe, link.getMacs);

export const { useSession, useLinkRead } = linkHooks(link);

/** A `file://` URI for an image the shown Mac's transcript names. */
export function assetUri(ref: AssetRef): Promise<string> {
  if (!shownMac) return Promise.reject(new Error("This phone is not connected to a Mac."));
  return assets.uri(shownMac, ref);
}

/** What phone access allows: the Mac's own methods, and those of a Mac that shares its OpenOrc Cloud threads. */
type PhoneMethod = RemoteMethod | CloudRemoteMethod;

// The phone may call only what phone access allows; these narrow the shared hooks so anything else does not compile.
export const useRpc = <M extends PhoneMethod>(method: M, params: RpcParams<M>, options?: RpcQueryOptions<M>): UseQueryResult<RpcResults[M]> => client.useRpc(method, params, options);
export const useRpcs = <M extends PhoneMethod>(method: M, paramsList: readonly RpcParams<M>[], options?: RpcQueryOptions<M>): UseQueryResult<RpcResults[M]>[] =>
  client.useRpcs(method, paramsList, options);
export const useRpcMutation = <M extends PhoneMethod>(method: M): UseMutationResult<RpcResults[M], Error, RpcParams<M>> => client.useRpcMutation(method);
export const { queryClient, useRun } = client;
