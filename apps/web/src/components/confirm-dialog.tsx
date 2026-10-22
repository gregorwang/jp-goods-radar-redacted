"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  confirmationText?: string;
  eyebrow?: string;
  cancelLabel?: string;
  busyLabel?: string;
  errorFallback?: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  confirmationText,
  eyebrow = "DESTRUCTIVE ACTION",
  cancelLabel = "保留档案",
  busyLabel = "正在删除…",
  errorFallback = "删除失败，请稍后再试。",
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [typedText, setTypedText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setTypedText("");
      setError("");
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const confirmationMatches = confirmationText === undefined || typedText === confirmationText;

  async function confirm() {
    if (!confirmationMatches || busy) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : errorFallback);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <div className="confirm-dialog-index" aria-hidden="true">CAUTION / 01</div>
      <button className="confirm-dialog-close" type="button" aria-label="关闭确认窗口" onClick={onCancel} disabled={busy}>
        <X size={17} aria-hidden="true" />
      </button>
      <div className="confirm-dialog-mark" aria-hidden="true"><AlertTriangle size={20} /></div>
      <div className="confirm-dialog-copy">
        <p className="eyebrow">{eyebrow}</p>
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
      </div>
      {confirmationText !== undefined && (
        <label className="confirm-dialog-verification">
          <span>输入档案名称以确认</span>
          <strong>{confirmationText}</strong>
          <input
            className="text-input"
            value={typedText}
            onChange={(event) => setTypedText(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      )}
      {error && <p className="confirm-dialog-error" role="alert">{error}</p>}
      <div className="confirm-dialog-actions">
        <button className="ghost-button" type="button" onClick={onCancel} disabled={busy} autoFocus>{cancelLabel}</button>
        <button className="ghost-button danger-button" type="button" onClick={() => void confirm()} disabled={busy || !confirmationMatches}>
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
