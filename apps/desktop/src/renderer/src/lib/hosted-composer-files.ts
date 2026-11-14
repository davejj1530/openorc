import type { HostedAvailability, HostedDraftFile } from "@openorc/protocol";

const CHECKING = "Checking OpenOrc Cloud…";

/**
 * Why a cloud composer cannot attach, and why it cannot send yet. Only the draft's own files hold Send: a file still
 * uploading or a failed one, and the first read of what the draft holds. Words alone always go.
 */
export function hostedFileReasons(input: { scope: boolean; availability: HostedAvailability | undefined; availabilityError: Error | null; files: readonly HostedDraftFile[]; loading: boolean }) {
  return { attach: attachReason(input), send: sendReason(input.files, input.loading) };
}

function attachReason({ scope, availability, availabilityError }: { scope: boolean; availability: HostedAvailability | undefined; availabilityError: Error | null }): string | null {
  if (!scope) return CHECKING;
  if (availabilityError) return availabilityError.message;
  if (!availability) return CHECKING;
  return availability.available ? null : availability.reason;
}

function sendReason(files: readonly HostedDraftFile[], loading: boolean): string | null {
  if (files.some((file) => file.state.kind === "failed")) return "Retry or remove the refused file to send.";
  if (files.some((file) => file.state.kind !== "ready")) return "Wait for the files to finish uploading.";
  return loading ? "Wait for this draft's files to load." : null;
}
