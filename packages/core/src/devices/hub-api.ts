import type { Device } from "@openorc/protocol";

/** A request to the hub; the supervisor adds the token. */
export type HubRequest = (route: string, init?: RequestInit) => Promise<Response>;

interface HubActionResult {
  ok: boolean;
  serial?: string;
  error?: string;
  errors?: string[];
}

// The hub waits up to three minutes for an emulator to come online.
const BOOT_TIMEOUT_MS = 4 * 60_000;
const SHUTDOWN_TIMEOUT_MS = 60_000;
const SCREENSHOT_TIMEOUT_MS = 20_000;
const MESSAGE_LIMIT = 600;

function parseAction(value: unknown): HubActionResult | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record["ok"] !== "boolean") return null;
  const text = (item: unknown) => (typeof item === "string" && item.trim() ? item.trim() : undefined);
  const errors = Array.isArray(record["errors"]) ? record["errors"].map((item) => text((item as { message?: unknown } | null)?.message)).filter((item) => item !== undefined) : [];
  const serial = text(record["serial"]) ?? text(record["id"]);
  const error = text(record["error"]);
  return { ok: record["ok"], ...(serial ? { serial } : {}), ...(error ? { error } : {}), errors };
}

async function postAction(request: HubRequest, route: string, body: Record<string, string>, timeoutMs: number): Promise<HubActionResult> {
  const response = await request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const parsed = parseAction(await response.json().catch(() => null));
  if (parsed) return parsed;
  return { ok: false, error: `The device hub answered ${response.status}.` };
}

/** The hub's own words for a failure, kept short: they reach the user and agents. */
function failure(result: HubActionResult, fallback: string): string {
  const text = [result.error, ...(result.errors ?? [])].filter(Boolean).join("\n").trim() || fallback;
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT - 1)}…` : text;
}

/** Boots a device. Android answers with the serial its emulator got. The hub boots an AVD by its name. */
export async function bootOnHub(request: HubRequest, device: Device): Promise<{ serial: string | null }> {
  const name = device.platform === "android" ? device.id : device.name;
  const result = await postAction(request, "/api/devices/boot", { platform: device.platform, id: device.id, name }, BOOT_TIMEOUT_MS);
  if (!result.ok) throw new Error(failure(result, `${device.name} did not start.`));
  return { serial: device.platform === "android" ? (result.serial ?? null) : null };
}

/**
 * iOS goes through serve-sim, which closes its capture session before it runs `simctl shutdown`; the hub's generic
 * shutdown could leave that session cached across the next boot. Android shuts down by serial.
 */
export async function shutdownOnHub(request: HubRequest, device: Device, serial: string | null): Promise<void> {
  if (device.platform === "android" && !serial) return;
  const result =
    device.platform === "ios"
      ? await postAction(request, "/vendor/serve-sim/grid/api/shutdown", { udid: device.id }, SHUTDOWN_TIMEOUT_MS)
      : await postAction(request, "/api/devices/shutdown", { platform: "android", id: serial! }, SHUTDOWN_TIMEOUT_MS);
  if (!result.ok) throw new Error(failure(result, `${device.name} did not shut down.`));
}

/** A PNG of the device's screen. */
export async function screenshotOnHub(request: HubRequest, device: Device, serial: string | null): Promise<Buffer> {
  const target = device.platform === "ios" ? device.id : serial;
  if (!target) throw new Error(`${device.name} is not running.`);
  const vendor = device.platform === "ios" ? "serve-sim" : "serve-emu";
  const response = await request(`/vendor/${vendor}/api/screenshot?device=${encodeURIComponent(target)}`, { method: "POST", signal: AbortSignal.timeout(SCREENSHOT_TIMEOUT_MS) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`The screenshot of ${device.name} failed (${response.status}).`);
  }
  return Buffer.from(await response.arrayBuffer());
}
