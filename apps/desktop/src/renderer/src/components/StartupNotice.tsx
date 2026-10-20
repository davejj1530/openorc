import { useEffect, useState } from "react";
import { core } from "../lib/rpc";

/** Says why the app is still waiting on the core, for the rare startup that does something slow first. */
export function StartupNotice() {
  const [message, setMessage] = useState(core.startup);
  // Read again once subscribed, in case the push arrived between the first render and now.
  useEffect(() => {
    setMessage(core.startup);
    return core.onStartup(setMessage);
  }, []);
  if (!message) return null;
  return (
    <p role="status" className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-xl bg-float-fill px-4 py-2.5 text-base text-ink-2">
      {message}
    </p>
  );
}
