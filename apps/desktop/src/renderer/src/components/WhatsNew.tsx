import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import cloudDark from "../assets/whats-new/cloud-dark.webp";
import cloudLight from "../assets/whats-new/cloud-light.webp";
import phoneDark from "../assets/whats-new/phone-dark.webp";
import phoneLight from "../assets/whats-new/phone-light.webp";
import teamDark from "../assets/whats-new/team-dark.webp";
import teamLight from "../assets/whats-new/team-light.webp";
import { CoversPreview } from "../lib/browser-preview";
import { cn } from "../lib/cn";
import { useRpc } from "../lib/client";
import { useOrganization } from "../lib/organization-context";
import { useRouter } from "../lib/router";
import { useWhatsNew } from "../lib/whats-new";
import { X } from "./icons";
import { Button, IconButton } from "./ui";
import "../styles/whats-new.css";

type StepId = "cloud" | "team" | "phone";

/** What the update brought, one thing a person can now do per step, each shown as the app draws it. */
const steps: readonly { id: StepId; title: string; line: string; light: string; dark: string; alt: string }[] = [
  {
    id: "cloud",
    title: "Threads that keep working with your Mac closed",
    line: "Start a thread on OpenOrc Cloud and its agent works on its own machine.",
    light: cloudLight,
    dark: cloudDark,
    alt: "Cloud threads in the thread list, two of them working",
  },
  {
    id: "team",
    title: "Work with your team",
    line: "Invite people to an organization to share projects and work in each other's threads.",
    light: teamLight,
    dark: teamDark,
    alt: "A cloud thread with messages from Mara Okafor and Theo Laurent",
  },
  {
    id: "phone",
    title: "Your cloud threads on your phone",
    line: "Read and reply from OpenOrc on iPhone, even with your Mac asleep.",
    light: phoneLight,
    dark: phoneDark,
    alt: "A cloud thread open in OpenOrc on iPhone",
  },
];

/** Reads the version running once, at start, and settles whether its steps are due. */
export function useSettleWhatsNew() {
  useEffect(() => {
    // A renderer hot reload can precede the new preload in development.
    const version = window.openorc?.updates?.version;
    if (!version) return;
    version().then(
      (running) => useWhatsNew.getState().settle(running),
      () => {
        /* Without its version the app shows no steps; it asks again at the next start. */
      },
    );
  }, []);
}

const popupOpen = () => document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') !== null;
function watchPopups(changed: () => void) {
  const observer = new MutationObserver(changed);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}
const watchNothing = () => () => {};

/** The steps, once they are due and nothing else is open: a dialog, a menu or a list a person is in comes first. */
export function WhatsNew() {
  const due = useWhatsNew((state) => state.due);
  const [shown, setShown] = useState(false);
  const busy = useSyncExternalStore(due && !shown ? watchPopups : watchNothing, popupOpen);
  useEffect(() => {
    if (due && !shown && !busy) setShown(true);
  }, [due, shown, busy]);
  return <WhatsNewSheet open={Boolean(due) && shown} onClose={() => useWhatsNew.getState().close()} />;
}

/** A step's way to try it: sign in first, then the place it lives. */
function useStepAction(step: StepId): { label: string; run(): void } | null {
  const account = useRpc("account.status", {}).data;
  const organization = useOrganization();
  const navigate = useRouter((state) => state.navigate);
  if (!account) return null;
  if (account.state !== "signed-in") return { label: "Sign in", run: () => navigate({ view: "settings", section: "account" }) };
  if (step === "cloud") return { label: "Open Cloud settings", run: () => navigate({ view: "settings", section: "cloud" }) };
  if (step === "phone") return { label: "Open Phone settings", run: () => navigate({ view: "settings", section: "phone" }) };
  return organization ? { label: "Create organization", run: organization.create } : null;
}

/** One step at a time: its picture, what it is, a way to try it, and Next. Any way out closes it for good. */
export function WhatsNewSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const step = steps[index]!;
  const last = index === steps.length - 1;
  const action = useStepAction(step.id);
  const next = useRef<HTMLButtonElement>(null);
  return (
    <BaseDialog.Root open={open} onOpenChange={(opened) => (opened ? undefined : onClose())}>
      <BaseDialog.Portal>
        <CoversPreview />
        <BaseDialog.Backdrop className="dialog-backdrop fixed inset-0" />
        <BaseDialog.Popup initialFocus={next} className="dialog-sheet whats-new fixed inset-x-0 top-1/5 mx-auto">
          <div key={`picture:${step.id}`} className="whats-new-picture motion-arrive">
            <img src={step.light} alt={step.alt} className="dark:hidden" />
            <img src={step.dark} alt={step.alt} className="hidden dark:block" />
          </div>
          <BaseDialog.Title key={`title:${step.id}`} className="whats-new-title motion-arrive">
            {step.title}
          </BaseDialog.Title>
          <BaseDialog.Description key={`line:${step.id}`} className="whats-new-line motion-arrive">
            {step.line}
          </BaseDialog.Description>
          <BaseDialog.Close render={<IconButton aria-label="Close" size="sm" className="whats-new-close" />}>
            <X size={15} />
          </BaseDialog.Close>
          <div className="whats-new-foot">
            <div className="whats-new-dots">
              {steps.map((each, at) => (
                <button
                  key={each.id}
                  type="button"
                  aria-label={each.title}
                  aria-current={at === index ? "step" : undefined}
                  className={cn("whats-new-dot", at === index && "whats-new-dot-current")}
                  onClick={() => setIndex(at)}
                />
              ))}
            </div>
            {action ? (
              <Button
                onClick={() => {
                  onClose();
                  action.run();
                }}
              >
                {action.label}
              </Button>
            ) : null}
            <Button ref={next} variant="primary" onClick={() => (last ? onClose() : setIndex(index + 1))}>
              {last ? "Done" : "Next"}
            </Button>
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
