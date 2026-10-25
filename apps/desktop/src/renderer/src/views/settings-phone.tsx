import { useEffect, useRef, useState } from "react";
import { relativeTime } from "@openorc/client";
import type { PairingOfferView, RemoteDevice, Route } from "@openorc/protocol";
import { ChevronDown } from "../components/icons";
import { QrCode } from "../components/QrCode";
import { Button, Dialog, TextButton } from "../components/ui";
import { queryClient, useRpc, useRpcMutation } from "../lib/client";
import { core } from "../lib/rpc";
import { PushKey } from "./settings-phone-push";
import { LoadError, Section, Status, Toggle } from "./settings-shared";

/** Phone access: the switch, where this Mac listens, the phones paired with it, and the key their alerts are signed with. */
export function PhoneSettings({ active }: { active: boolean }) {
  const status = useRpc("remote.status", {}, { enabled: active });
  const configure = useRpcMutation("remote.configure");
  const listener = status.data?.listener;
  const devices = status.data?.devices ?? [];
  // The switch follows a change while it is saving, then what the core reports.
  const enabled = configure.isPending ? configure.variables.enabled : Boolean(listener && listener.state !== "off");
  const setEnabled = (value: boolean) => configure.mutate({ enabled: value }, { onSuccess: (next) => queryClient.setQueryData(["remote.status", {}], next) });
  return (
    <>
      {status.isError && <LoadError retry={() => void status.refetch()} />}
      <Section title="Access">
        <Toggle label="Allow paired phones" checked={enabled} disabled={!status.data || configure.isPending} onChange={setEnabled} />
        {listener?.state === "on" && listener.routes.length > 0 && <Addresses routes={listener.routes} />}
        {listener?.state === "failed" && !configure.isPending && (
          <p role="alert" className="phone-note motion-arrive text-bad">
            {listener.reason}{" "}
            <TextButton tone="muted" onClick={() => setEnabled(true)}>
              Try again
            </TextButton>
          </p>
        )}
        {configure.error && (
          <p role="alert" className="phone-note text-bad">
            {configure.error.message}
          </p>
        )}
      </Section>
      <div className="motion-collapse" hidden={!enabled && devices.length === 0}>
        <Section title="Paired phones">
          {devices.length ? devices.map((device) => <PhoneRow key={device.id} device={device} />) : <p className="flex min-h-13 items-center text-ink-3">No paired phones yet.</p>}
        </Section>
      </div>
      {enabled && status.data && <PushKey push={status.data.push} />}
    </>
  );
}

const routeKinds: Record<Route["kind"], string> = { lan: "Same network", tailnet: "Tailscale" };

/** Where a phone can reach this Mac, closed until asked for. */
function Addresses({ routes }: { routes: Route[] }) {
  return (
    <details className="phone-addresses motion-disclosure">
      <summary>
        Addresses
        <span>
          {routes.length}
          <ChevronDown size={14} />
        </span>
      </summary>
      <ul>
        {routes.map((route) => (
          <li key={`${route.kind}:${route.host}`}>
            <code>
              {route.host}:{route.port}
            </code>
            <span>{routeKinds[route.kind]}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function PhoneRow({ device }: { device: RemoteDevice }) {
  const remove = useRpcMutation("remote.devices.remove");
  return (
    <div className="settings-field">
      <span className="truncate">{device.name}</span>
      <div className="flex items-center gap-4">
        <Status ok={device.connected}>{presence(device)}</Status>
        <Button size="sm" aria-label={`Remove ${device.name}`} disabled={remove.isPending} onClick={() => remove.mutate({ id: device.id })}>
          Remove
        </Button>
      </div>
      {remove.error && (
        <p role="alert" className="w-full text-sm text-bad">
          {remove.error.message}
        </p>
      )}
    </div>
  );
}

function presence(device: RemoteDevice): string {
  if (device.connected) return "Connected";
  return device.lastSeenAt === null ? `Paired ${relativeTime(device.createdAt)}` : `Last seen ${relativeTime(device.lastSeenAt)}`;
}

/** Where the pairing sheet is: waiting for its code, showing it, or past it. */
export type PairingSheet =
  | { kind: "starting" }
  | { kind: "failed"; reason: string }
  | { kind: "live"; offer: PairingOfferView; secondsLeft: number }
  | { kind: "expired"; offer: PairingOfferView }
  /** The status listed the offer and dropped it before it expired: a phone spent it, or another window replaced it. */
  | { kind: "spent"; offer: PairingOfferView };

export function pairingSheet({ offer, error, seen, listed, now }: { offer: PairingOfferView | undefined; error: Error | null; seen: boolean; listed: boolean; now: number }): PairingSheet {
  if (error) return { kind: "failed", reason: error.message };
  if (!offer) return { kind: "starting" };
  if (now >= offer.expiresAt) return { kind: "expired", offer };
  if (seen && !listed) return { kind: "spent", offer };
  return { kind: "live", offer, secondsLeft: Math.ceil((offer.expiresAt - now) / 1000) };
}

/** The Phone page's ink pill, while phones can connect, and the sheet with the code it opens. */
export function PairPhone() {
  const status = useRpc("remote.status", {});
  const pairing = usePairing(status.data?.pairing?.offerId);
  return (
    <>
      {status.data?.listener.state === "on" && (
        <Button variant="primary" size="lg" onClick={pairing.start}>
          Pair a phone
        </Button>
      )}
      <Dialog open={pairing.open} onOpenChange={(open) => (open ? undefined : pairing.close())} title="Pair a phone" width={360}>
        <PairingCode sheet={pairing.sheet} retry={pairing.start} />
      </Dialog>
    </>
  );
}

function usePairing(listedOfferId: string | undefined) {
  const begin = useRpcMutation("remote.pairing.begin");
  const cancel = useRpcMutation("remote.pairing.cancel");
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<string | null>(null);
  const offer = begin.data;
  const listed = offer !== undefined && listedOfferId === offer.offerId;
  const sheet = pairingSheet({ offer, error: begin.error, seen: seen === offer?.offerId, listed, now: Date.now() });
  useTicker(open && sheet.kind === "live");
  useEffect(() => {
    if (listed && offer) setSeen(offer.offerId);
  }, [listed, offer]);
  useEffect(() => {
    if (sheet.kind === "spent") setOpen(false);
  }, [sheet.kind]);
  // Leaving Settings with the sheet open takes its code with it.
  const liveOffer = useRef<string | null>(null);
  useEffect(() => {
    liveOffer.current = open && sheet.kind === "live" ? sheet.offer.offerId : null;
  });
  useEffect(
    () => () => {
      if (liveOffer.current) void core.call("remote.pairing.cancel", { offerId: liveOffer.current });
    },
    [],
  );
  return {
    open,
    sheet,
    start: () => {
      setOpen(true);
      begin.mutate({});
    },
    close: () => {
      if (sheet.kind === "live") cancel.mutate({ offerId: sheet.offer.offerId });
      setOpen(false);
    },
  };
}

/** Renders once a second while active, for a countdown read from the clock. */
function useTicker(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
}

function PairingCode({ sheet, retry }: { sheet: PairingSheet; retry: () => void }) {
  if (sheet.kind === "failed")
    return (
      <p role="alert" className="text-bad">
        {sheet.reason}{" "}
        <TextButton tone="muted" onClick={retry}>
          Try again
        </TextButton>
      </p>
    );
  const expired = sheet.kind === "expired";
  return (
    <div className="pairing-code">
      <div className="pairing-code-stage">
        <div className="pairing-code-plate" data-state={sheet.kind}>
          {sheet.kind !== "starting" && <QrCode value={sheet.offer.url} label="Pairing code" />}
        </div>
        {expired && (
          <Button variant="primary" size="sm" className="motion-arrive" onClick={retry}>
            New code
          </Button>
        )}
      </div>
      <div>
        <p className="text-ink-2">Scan with OpenOrc on your phone. {sheet.kind === "live" ? <CopyLink url={sheet.offer.url} /> : null}</p>
        <p className="motion-swap min-h-5 text-sm text-ink-4 tabular">
          <span aria-hidden={expired}>{sheet.kind === "live" ? `Expires in ${countdown(sheet.secondsLeft)}` : null}</span>
          <span aria-hidden={!expired}>This code expired.</span>
        </p>
      </div>
    </div>
  );
}

/** The code as a link, for a phone that pastes it: Universal Clipboard carries it over. */
function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <TextButton tone="muted" onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true))}>
      {copied ? "Copied" : "Copy link"}
    </TextButton>
  );
}

const countdown = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
