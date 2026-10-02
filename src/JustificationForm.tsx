import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { justificationReasons } from "../shared/types";
import type { Delivery, TaskJustification } from "../shared/types";

export default function JustificationForm({
  task,
  record,
  onClose,
  onSaved,
}: {
  task: Delivery;
  record?: TaskJustification;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setError("");
    setSaving(true);
    try {
      await api("/justifications", {
        method: "POST",
        body: JSON.stringify({
          issueId: task.id,
          reason: values.get("reason"),
          explanation: values.get("explanation"),
        }),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby="justification-title"
      closedby={saving ? "none" : "any"}
      onClose={() => {
        if (!saving) onClose();
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
      onClick={(event) => {
        const element = event.currentTarget;
        if (
          saving ||
          "closedBy" in HTMLDialogElement.prototype ||
          event.target !== element
        )
          return;
        const rect = element.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          element.close();
      }}
    >
      <form onSubmit={submit}>
        <div className="dialog-heading">
          <h2 id="justification-title">
            {record ? "Edit justification" : "Justify late task"}
          </h2>
          <button
            type="button"
            className="quiet"
            onClick={onClose}
            disabled={saving}
          >
            Close
          </button>
        </div>
        <p className="muted">
          {task.identifier} · {task.studentName} · {task.title}
        </p>
        <p className="notice">
          Justified tasks are excluded from charts and totals. The task and its
          explanation remain available for review.
        </p>
        <label>
          Reason
          <select
            name="reason"
            defaultValue={record?.reason ?? "LINEAR_ERROR"}
            required
            disabled={saving}
          >
            {Object.entries(justificationReasons).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Explanation
          <textarea
            name="explanation"
            defaultValue={record?.explanation ?? ""}
            required
            maxLength={2000}
            rows={4}
            disabled={saving}
            placeholder="Describe the Linear error or the blocking task and why the delay is justified."
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="quiet"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button disabled={saving}>
            {saving ? "Saving…" : "Save justification"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
