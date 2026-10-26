import { TextButton } from "../ui";
import "./device.css";

/** A read from the core failed: one line in place of the page, and the way to try again. */
export function DeviceLoadError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="device-page">
      <p role="alert" className="device-notes" data-tone="bad">
        {message}{" "}
        <TextButton underline onClick={retry}>
          Try again
        </TextButton>
      </p>
    </div>
  );
}
