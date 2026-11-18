import { createClientState, createTeamChat, type RpcQueryOptions, type TeamChatDraftStorage } from "@openorc/client";
import { CLOUD_THREADS, PHONE_CAPABILITIES, type AssetRef, type CloudRemoteMethod, type Project, type RemoteMethod, type RpcMethod, type RpcParams, type RpcResults } from "@openorc/protocol";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { nativeApplicationVersion } from "expo-application";
import Constants from "expo-constants";
import { addNetworkStateListener, getNetworkStateAsync, NetworkStateType, type NetworkState } from "expo-network";
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { createMMKV } from "react-native-mmkv";
import { randomUUID } from "react-native-quick-crypto";
import { createAssetCache } from "./connection/asset-cache";
import { linkHooks } from "./connection/link-hooks";
import { dropSavedBrains } from "./connection/hosts";
import { ConnectionManager, showsDemo, type LinkState } from "./connection/manager";
import { forgetDoorKey, keychainKeys, openSocket, phoneCrypto, reachesInternet, storedMacs, systemClock } from "./connection/native";
import type { NetworkKind, SavedMac } from "./connection/saved-macs";
import { createDemoMac, DEMO_MAC } from "./demo/demo-mac";
import { forgetFolds } from "./home/fold-keys";
import { forgetHidden } from "./home/filter-keys";
import { spaceKey } from "./spaces/space-key";
import { forgetLists, keepLists, keptAnswers, restoreLists } from "./lists-cache";
export { chatFileUri, cloudFileUri, phoneFile, threadFileUri } from "./cloud/cloud-file-cache";
import { followMacLook } from "./look/look";
import { PhoneAlerts } from "./notifications/alerts";
import { oncePerNotice, presentationFor } from "./notifications/foreground";
import { handleAlerts, pushPlatform } from "./notifications/native";
import { threadOnScreen } from "./notifications/on-screen";
import { ScratchStore } from "./scratch-store";
import { liveSocketOf } from "@openorc/hosted/socket";
import { io } from "socket.io-client";
import { followMac } from "./cloud/follow-mac";
import { CloudAlerts } from "./cloud/cloud-alerts";
import { cloudKeys, keptIn, keychainVault } from "./cloud/native";
import { knowCloudSender } from "./notifications/on-screen";
import { PhoneCloud } from "./cloud/phone-cloud";
import { RoutedConnection } from "./cloud/routed-connection";
import { timeFrame } from "./thread/perf-probe";
import { whatsNewAtLaunch } from "./whats-new/whats-new";

/** The app's own key-value store on disk. Only saved Macs use it directly; the demo never touches them. */
const kept = createMMKV({ id: "openorc" });

/** What the app keeps (lists Home paints from on a cold start, folds, drafts, settings), scratched while the demo shows. */
export const storage = new ScratchStore(kept);

/** The saved Macs, less what an earlier build saved for a cloud brain, with its keys. */
const macs = storedMacs(kept);
dropSavedBrains(macs, (id) => void Promise.all([keychainKeys.remove(id), forgetDoorKey(id)]).catch(() => undefined));

/** The steps on what this update brought, decided once at launch, before a pairing: due to a phone that had a Mac paired. */
export const whatsNew = whatsNewAtLaunch(createMMKV({ id: "openorc-whats-new" }), nativeApplicationVersion, macs.list().length > 0);

/** The phone's connection to the Mac it shows. Created at load, so the route race starts while React mounts. */
export const link = new ConnectionManager({
  openSocket,
  crypto: phoneCrypto,
  clock: systemClock,
  random: Math.random,
  keys: keychainKeys,
  deviceName: Constants.deviceName ?? "iPhone",
  reachesInternet,
  macs,
  forgetCache: (macId) => {
    forgetLists(storage, macId);
    forgetFolds(storage, macId);
    forgetHidden(storage, macId);
    storage.remove(spaceKey(macId));
    assets.forget(macId);
  },
});

/**
 * The phone's own OpenOrc Cloud: a session of its own, which the Mac it shows gets it for the person signed in there,
 * kept in the Keychain and followed as that Mac's account changes.
 */
export const cloud = new PhoneCloud({
  vault: keychainVault,
  kept: keptIn(kept),
  fetch,
  connect: liveSocketOf(io),
  push: (push) => routed.cloudPush(push),
  projects: () => macProjects(),
  now: Date.now,
  log: { info: () => undefined, warn: (message) => console.warn(`[OpenOrc] ${message}`) },
});

/** The cloud answers for its own threads while the phone holds a session of its own; the Mac, over the link, for the rest. */
const routed = new RoutedConnection(
  link.connection,
  cloud,
  keptAnswers(storage, () => shownMac),
);

/** A call outside the client's queries, routed as theirs are: to the phone's own cloud for its threads, else to the Mac. */
/** A new id, unique as the server needs one, for what the phone makes: a note. */
export const newId = (): string => randomUUID();

export const call = <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => routed.call(method, params);

/** Client state over the link, built like the desktop's: same tags, same transcript reducer, another connection. */
export const client = createClientState(routed, {
  scheduleFrame: (callback) => requestAnimationFrame(timeFrame(callback)),
  // Every refetch is a trip over the network, and agents push "threads" about once a second while they work.
  invalidationBatchMs: 250,
  randomId: () => randomUUID(),
  // A phone may not change the Mac's app settings: a permission chosen here stays with its thread.
  savesDefaultPermission: false,
  reportFrameError: (frame, error) => console.warn("[OpenOrc] Dropped incoming frame", { runId: frame.runId, seq: frame.seq, error: error instanceof Error ? error.name : "Error" }),
});

/** Team chat's drafts and the messages not yet confirmed sent, in a store of their own, which chat lists by key. */
const chatKept = createMMKV({ id: "openorc-chat" });
const chatDrafts: TeamChatDraftStorage = {
  getItem: (key) => chatKept.getString(key) ?? null,
  setItem: (key, value) => chatKept.set(key, value),
  removeItem: (key) => void chatKept.remove(key),
  key: (index) => chatKept.getAllKeys()[index] ?? null,
  get length() {
    return chatKept.getAllKeys().length;
  },
};

/** Team chat in the person's organizations, read and written from the phone's own session, or through the Mac. */
export const teamChat = createTeamChat({ connection: routed, queryClient: client.queryClient, storage: chatDrafts, randomId: () => randomUUID() });

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
handleAlerts(oncePerNotice((data) => presentationFor(data, link.getState(), threadOnScreen(), cloudAlerts.senderKey())));
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

/** The shown Mac's projects with their remotes, as its list last answered, for matching the cloud's projects to them. */
function macProjects() {
  return (client.queryClient.getQueryData<Project[]>(["projects.list", {}]) ?? []).map((project) => ({ id: project.id, name: project.name, remote: project.gitRemote }));
}

const holds = () => cloud.holds;
// Holding a session of its own, the phone reads the cloud itself: it no longer asks the Mac for cloud threads.
link.connection.askFor(() => (holds() ? PHONE_CAPABILITIES.filter((capability) => capability !== CLOUD_THREADS) : PHONE_CAPABILITIES));
/**
 * Alerts about the person's OpenOrc Cloud threads, which the server sends while the phone holds a session of its own:
 * registered as this phone wants alerts, and kept so as that changes or the session does.
 */
export const cloudAlerts = new CloudAlerts({
  crypto: phoneCrypto,
  keys: cloudKeys,
  held: () => {
    const hosted = cloud.hosted;
    return hosted && holds() && cloud.server ? { server: cloud.server, registry: hosted.account } : null;
  },
  registration: () => alerts.registration(),
  warn: (message) => console.warn(`[OpenOrc] ${message}`),
});
knowCloudSender(() => cloudAlerts.senderKey());

let held = false;
/** The phone came to hold a session of its own, or lost it: the Mac hears what it asks for now, and every list is read again. */
function heldChanged(): void {
  void cloudAlerts.sync();
  if (holds() === held) return;
  held = holds();
  link.connection.renegotiate();
  void client.queryClient.invalidateQueries();
}
cloud.subscribe(heldChanged);

// The Mac's agents' models, which of them are signed in and its settings, on every session with it, kept with the
// lists, so a cloud thread's composer has a model to send with, and a new cloud thread its first model, while the Mac
// is asleep, even when neither was opened while it was awake.
let modelsRead: number | null = null;
link.subscribe(() => {
  const state = link.getState();
  if (state.kind !== "connected" || showsDemo(state) || state.serial === modelsRead) return;
  modelsRead = state.serial;
  void client.queryClient.prefetchQuery({ queryKey: ["agents.models", {}], queryFn: () => link.connection.call("agents.models", {}), staleTime: 5 * 60_000 });
  void client.queryClient.prefetchQuery({ queryKey: ["agents.availability", {}], queryFn: () => link.connection.call("agents.availability", {}) });
  void client.queryClient.prefetchQuery({ queryKey: ["app.settings.get", {}], queryFn: () => link.connection.call("app.settings.get", {}) });
});
alerts.subscribe(() => void cloudAlerts.sync());
void cloud.start().then(() => followMac(link, cloud, (message) => console.warn(`[OpenOrc] ${message}`)));
