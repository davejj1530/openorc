import { createClientState, type RpcQueryOptions } from "@openorc/client";
import type { AssetRef, RemoteMethod, RpcParams, RpcResults } from "@openorc/protocol";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import Constants from "expo-constants";
import { addNetworkStateListener, getNetworkStateAsync, NetworkStateType, type NetworkState } from "expo-network";
import { useContext, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { createMMKV } from "react-native-mmkv";
import { randomUUID } from "react-native-quick-crypto";
import { createAssetCache } from "./connection/asset-cache";
import { linkHooks } from "./connection/link-hooks";
import { HostContext } from "./connection/host-context";
import { doorsOnIntent, groupOf, namedBrain, partnerStore, forgetRemovedBrains, withPartnerRecord } from "./connection/hosts";
import { ConnectionManager, showsDemo, type LinkState } from "./connection/manager";
import { phoneDoors } from "./connection/door";
import { keychainDoorKeys, keychainKeys, openSocket, phoneCrypto, postKnock, reachesInternet, storedMacs, systemClock } from "./connection/native";
import type { NetworkKind, SavedMac } from "./connection/saved-macs";
import { createDemoMac, DEMO_MAC } from "./demo/demo-mac";
import { forgetFolds } from "./home/fold-keys";
import { forgetLists, keepLists, restoreLists } from "./lists-cache";
import { followMacLook } from "./look/look";
import { PhoneAlerts } from "./notifications/alerts";
import { oncePerNotice, presentationFor } from "./notifications/foreground";
import { routeOf } from "./notifications/taps";
import { handleAlerts, pushPlatform } from "./notifications/native";
import { threadOnScreen } from "./notifications/on-screen";
import { ScratchStore } from "./scratch-store";
import { timeFrame } from "./thread/perf-probe";

/** The app's own key-value store on disk. Only saved Macs use it directly; the demo never touches them. */
const kept = createMMKV({ id: "openorc" });

/** What the app keeps (lists Home paints from on a cold start, folds, drafts, settings), scratched while the demo shows. */
export const storage = new ScratchStore(kept);

const macs = storedMacs(kept);
const effects = {
  openSocket,
  crypto: phoneCrypto,
  clock: systemClock,
  random: Math.random,
  keys: keychainKeys,
  deviceName: Constants.deviceName ?? "iPhone",
  reachesInternet,
  doors: phoneDoors({ crypto: phoneCrypto, clock: systemClock, post: postKnock, keys: keychainDoorKeys }),
  brainsRemoved: forgetRemovedBrains(macs, (id) => void link.forget(id)),
};

/** The phone's connection to the host it shows. Created at load, so the route race starts while React mounts. */
export const link = new ConnectionManager({
  ...effects,
  macs,
  forgetCache: (macId) => {
    forgetLists(storage, macId);
    forgetFolds(storage, macId);
    assets.forget(macId);
  },
});

let partnerId: string | null = null;
let partnerScreens = 0;
/** The connection to the host the shown one pairs with: a Mac and its cloud brain. It never pairs or forgets. */
export const partnerLink = new ConnectionManager({
  ...effects,
  doors: doorsOnIntent(effects.doors, () => partnerScreens > 0),
  macs: partnerStore(macs, () => partnerId),
  forgetCache: () => undefined,
});

/** A screen the person opened on a host. On the partner it may wake that host, as the shown one wakes; undone on close. */
export function openedOn(host: string | null): () => void {
  if (host === null || host !== partnerId) return () => undefined;
  partnerScreens++;
  void partnerLink.retry();
  return () => void partnerScreens--;
}

/**
 * Client state over the link, built like the desktop's: same tags, same transcript reducer, another connection. Not
 * exported: a screen reads its scope's host through useHostClient, so a cloud thread never asks the shown Mac.
 */
const client = createClientState(link.connection, {
  scheduleFrame: (callback) => requestAnimationFrame(timeFrame(callback)),
  // Every refetch is a trip over the network, and agents push "threads" about once a second while they work.
  invalidationBatchMs: 250,
  randomId: () => randomUUID(),
  // A phone may not change the Mac's app settings: a permission chosen here stays with its thread.
  savesDefaultPermission: false,
  reportFrameError: (frame, error) => console.warn("[OpenOrc] Dropped incoming frame", { runId: frame.runId, seq: frame.seq, error: error instanceof Error ? error.name : "Error" }),
});

/** The partner host's own client state: its lists, runs and assets never mix with the shown host's. */
export const partnerClient = createClientState(partnerLink.connection, {
  scheduleFrame: (callback) => requestAnimationFrame(callback),
  invalidationBatchMs: 250,
  randomId: () => randomUUID(),
  savesDefaultPermission: false,
  reportFrameError: (frame, error) => console.warn("[OpenOrc] Dropped incoming frame", { runId: frame.runId, seq: frame.seq, error: error instanceof Error ? error.name : "Error" }),
});

/** Which alerts this phone wants from each Mac, told to the shown one on every session and at once on a change. */
export const alerts = new PhoneAlerts({ link, platform: pushPlatform, storage });
/** The partner host hears the same choices on each of its sessions, so its own alerts reach this phone too. */
const partnerAlerts = new PhoneAlerts({ link: partnerLink, platform: pushPlatform, storage });

const assets = createAssetCache((ref) => link.connection.asset(ref), phoneCrypto.sha256);
const partnerAssets = createAssetCache((ref) => partnerLink.connection.asset(ref), phoneCrypto.sha256);

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

/** Follows the shown host's group: the partner's link and client go with whichever host pairs with it. */
function regroup(): void {
  const { partner } = groupOf(macs.list(), showsDemo(link.getState()) ? null : macs.activeId());
  const next = partner?.id ?? null;
  if (next === partnerId) return;
  partnerId = next;
  partnerClient.queryClient.clear();
  partnerClient.runs.reset();
  partnerLink.connection.reset(next !== null && restoreLists(partnerClient.queryClient, storage, next));
  if (next) partnerLink.select(next);
  else partnerLink.release();
  for (const listener of groupListeners) listener();
}
const groupListeners = new Set<() => void>();

/** A Mac names its cloud brain on each new session; the group follows at once and on every cold start after. */
let heardFrom = 0;
link.subscribe(() => {
  const state = link.getState();
  if (state.kind !== "connected" || state.serial === heardFrom) return;
  heardFrom = state.serial;
  void link.connection
    .call("cloud.offer", {})
    .then((offer) => {
      if (namedBrain(macs, state.mac.id, offer.brain?.host ?? null)) regroup();
    })
    .catch(() => undefined);
});
link.subscribe(regroup);
keepLists(partnerClient.queryClient, storage, () => partnerId);

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

// The partner's link starts showing nothing, so the group's first regroup dials the partner once.
partnerLink.start("other");
link.start("other");
regroup();
// A first launch, or any launch with no Mac paired, opens on the demo; Skip is in reach from its first frame.
showDemo();
alerts.start();
partnerAlerts.start();
handleAlerts(oncePerNotice((data) => presentationFor(data, (routeOf(data)?.macId === partnerId ? partnerLink : link).getState(), threadOnScreen())));
void getNetworkStateAsync().then((state) => {
  link.setNetwork(networkKind(state));
  partnerLink.setNetwork(networkKind(state));
});
addNetworkStateListener((state) => {
  link.setNetwork(networkKind(state));
  partnerLink.setNetwork(networkKind(state));
});
AppState.addEventListener("change", (state) => {
  link.appState(state === "background" ? "background" : "active");
  partnerLink.appState(state === "background" ? "background" : "active");
  // iOS Settings may have changed alerts while the app was away.
  if (state === "active") void alerts.refresh();
});

/** The Mac this phone shows, or null while none is paired. */
export const shownMacId = (): string | null => shownMac;
/** The host the shown one pairs with, or null. */
export const partnerHost = (): string | null => partnerId;

/** The link a scope names: the partner's while it is the partner, otherwise the shown host's. */
export function hostLink(host: string | null): ConnectionManager {
  return host !== null && host === partnerId ? partnerLink : link;
}

/** The link to the host this screen is scoped to, as it changes. */
export function useLinkState(): LinkState {
  const scoped = hostLink(useContext(HostContext));
  return useSyncExternalStore(scoped.subscribe, scoped.getState);
}

let savedHosts = { shown: link.getMacs(), partner: partnerLink.getMacs(), list: link.getMacs() };
/** The hosts this phone paired with, the partner as its own link last saved it (its name and routes are learned there). */
function readSavedHosts(): readonly SavedMac[] {
  const shown = link.getMacs();
  const partner = partnerLink.getMacs();
  if (shown !== savedHosts.shown || partner !== savedHosts.partner) savedHosts = { shown, partner, list: withPartnerRecord(shown, partner) };
  return savedHosts.list;
}
function subscribeHosts(listener: () => void): () => void {
  const stopShown = link.subscribe(listener);
  const stopPartner = partnerLink.subscribe(listener);
  return () => {
    stopShown();
    stopPartner();
  };
}

/** The hosts this phone paired with, as either link saves one. */
export function useSavedMacs(): readonly SavedMac[] {
  return useSyncExternalStore(subscribeHosts, readSavedHosts);
}

const shownHooks = linkHooks(link);
const partnerHooks = linkHooks(partnerLink);
// Both sets call the same hooks, so a scope's choice never changes their order.
const useScopedHooks = () => (hostLink(useContext(HostContext)) === partnerLink ? partnerHooks : shownHooks);
export const useSession = (): number | null => useScopedHooks().useSession();
export const useLinkRead: typeof shownHooks.useLinkRead = (key, read) => useScopedHooks().useLinkRead(key, read);

/** A `file://` URI for an image a host's transcript names: the shown host's, or the partner's when `host` is it. */
export function assetUri(ref: AssetRef, host: string | null = null): Promise<string> {
  if (hostLink(host) === partnerLink && partnerId) return partnerAssets.uri(partnerId, ref);
  if (!shownMac) return Promise.reject(new Error("This phone is not connected to a Mac."));
  return assets.uri(shownMac, ref);
}

/** The host a scope names, or the shown one; the partner's id resolves to its client only while it is the partner. */
export function hostClient(host: string | null): typeof client {
  return host !== null && host === partnerId ? partnerClient : client;
}

/** The client of the host this screen is scoped to. Both clients have the same hooks, so their order never changes. */
export const useHostClient = (): typeof client => hostClient(useContext(HostContext));

/** The current group, as it changes. */
export function useHostGroup(): { primary: string | null; partner: string | null } {
  const partner = useSyncExternalStore(
    (listener) => {
      groupListeners.add(listener);
      return () => groupListeners.delete(listener);
    },
    () => partnerId,
  );
  return { primary: shownMac, partner };
}

export const usePartnerLinkState = (): LinkState => useSyncExternalStore(partnerLink.subscribe, partnerLink.getState);

// The phone may call only what phone access allows; these narrow the shared hooks so anything else does not compile.
// Each reads the host its screen is scoped to; every client's hooks call the same hooks, so their order never changes.
export const useRpc = <M extends RemoteMethod>(method: M, params: RpcParams<M>, options?: RpcQueryOptions<M>): UseQueryResult<RpcResults[M]> =>
  hostClient(useContext(HostContext)).useRpc(method, params, options);
export const useRpcs = <M extends RemoteMethod>(method: M, paramsList: readonly RpcParams<M>[], options?: RpcQueryOptions<M>): UseQueryResult<RpcResults[M]>[] =>
  hostClient(useContext(HostContext)).useRpcs(method, paramsList, options);
export const useRpcMutation = <M extends RemoteMethod>(method: M): UseMutationResult<RpcResults[M], Error, RpcParams<M>> => hostClient(useContext(HostContext)).useRpcMutation(method);
export const useRun: typeof client.useRun = (...args) => hostClient(useContext(HostContext)).useRun(...args);
export const { queryClient } = client;
