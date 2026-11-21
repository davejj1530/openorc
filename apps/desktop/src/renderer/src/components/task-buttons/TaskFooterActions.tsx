import { useState, type ReactNode } from "react";
import { WORKSPACE_ID, type Task, type TaskButton } from "@openorc/protocol";
import { useRpcMutation } from "../../lib/client";
import { addToConversationDraft } from "../../lib/conversation-draft";
import { openProject, openThread } from "../../lib/router";
import { SlidersHorizontal } from "../icons";
import { Button, IconButton, Tooltip } from "../ui";
import { showsOn } from "./task-button-rules";
import "./task-buttons.css";

const pendingLabel = (button: TaskButton) => (button.autoSend === false ? "Opening…" : "Starting…");

export function TaskFooterActions({
  task,
  buttons,
  disabled,
  beforeRun,
  children,
}: {
  task: Task;
  buttons: readonly TaskButton[];
  disabled: boolean;
  beforeRun: () => Promise<boolean>;
  children: ReactNode;
}) {
  const run = useRpcMutation("tasks.runButton");
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const press = async (button: TaskButton) => {
    // Running from the press, so another one while the task saves can't start a second run.
    setRunning(button.id);
    setError(null);
    try {
      if (!(await beforeRun())) return;
      const pressed = await run.mutateAsync({ taskId: task.id, buttonId: button.id });
      if ("message" in pressed) addToConversationDraft(pressed.threadId, pressed.message, pressed.draft);
      openThread(pressed.threadId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setRunning(null);
    }
  };
  return (
    <div className="task-footer-actions">
      {error ? (
        <p role="alert" className="min-w-0 text-sm text-bad break-words">
          {error}
        </p>
      ) : null}
      {buttons
        .filter((button) => showsOn(button, task.status))
        .map((button) => (
          <Button key={button.id} data-tip={button.prompt} disabled={disabled || running !== null} onClick={() => void press(button)}>
            {running === button.id ? pendingLabel(button) : button.label}
          </Button>
        ))}
      {task.projectId === WORKSPACE_ID ? null : (
        <Tooltip label="Task buttons">
          <IconButton aria-label="Edit task buttons" onClick={() => openProject(task.projectId)}>
            <SlidersHorizontal size={15} />
          </IconButton>
        </Tooltip>
      )}
      {children}
    </div>
  );
}
