/**
 * The export dialog (issue 168): the three opt-in privacy options of core, all off each time it opens,
 * each with one sentence saying what it hides and what it does not, and a line saying what a
 * replay holds. The parent mounts it to open it and unmounts it to close it, so every opening
 * starts from the defaults. A modal `<dialog>`: focus moves into it and stays there, Escape or
 * Cancel closes it without saving. It is closed while it is still in the document, so the browser
 * puts focus back on the Export button that opened it; the parent focuses that button again once
 * the dialog is gone (the fallback without `showModal`).
 *
 * No `<form>`: the editor tab's webview blocks form submission (`enableForms: false`), so the
 * buttons act on click. Keys pressed inside the dialog do not reach the page's playback keys.
 */

import { useId, useLayoutEffect, useRef, useState } from "react";
import { isRoundTimesStep } from "@orbitrace/core";
import {
  DEFAULT_EXPORT_CHOICES,
  DEFAULT_ROUND_STEP,
  EXPORT_TEXT,
  type ExportChoices,
  type ReplaySaver,
} from "../export-replay";

export interface ExportDialogProps {
  /** The session is still running: say the file is a snapshot. */
  readonly live: boolean;
  /** Names the confirm button: Download in a browser, Save in the editor. */
  readonly saverKind: ReplaySaver["kind"];
  readonly onCancel: () => void;
  readonly onExport: (choices: ExportChoices) => void;
}

/** The step typed by the user as a number, or `null` when it is not one core takes. */
export function parseRoundStep(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return isRoundTimesStep(value) ? value : null;
}

/** Shows a modal `<dialog>` where the browser supports it, an open one otherwise. */
function show(dialog: HTMLDialogElement): void {
  if (dialog.open) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function hide(dialog: HTMLDialogElement): void {
  if (!dialog.open) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

export function ExportDialog({ live, saverKind, onCancel, onExport }: ExportDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stepRef = useRef<HTMLInputElement>(null);
  // Every opening starts with every option off (opt-in, issues 122 and 123).
  const [opaqueNames, setOpaqueNames] = useState(DEFAULT_EXPORT_CHOICES.opaqueNames);
  const [roundTimes, setRoundTimes] = useState(DEFAULT_EXPORT_CHOICES.roundTimes);
  const [stepText, setStepText] = useState(String(DEFAULT_EXPORT_CHOICES.roundStep));
  const [bucketTokens, setBucketTokens] = useState(DEFAULT_EXPORT_CHOICES.bucketTokens);
  const [stepError, setStepError] = useState(false);
  const id = useId();
  const ids = {
    title: `${id}-title`,
    contains: `${id}-contains`,
    opaque: `${id}-opaque`,
    opaqueHelp: `${id}-opaque-help`,
    round: `${id}-round`,
    roundHelp: `${id}-round-help`,
    step: `${id}-step`,
    stepError: `${id}-step-error`,
    bucket: `${id}-bucket`,
    bucketHelp: `${id}-bucket-help`,
  };

  // Open as a modal on mount; close on unmount. A layout effect, because its cleanup runs before
  // React removes the node: `close()` on a dialog that is still connected and modal is what makes
  // the browser restore focus. On a removed node it restores nothing, and focus falls to <body>.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    show(dialog);
    return () => hide(dialog);
  }, []);

  const confirm = (): void => {
    let roundStep = DEFAULT_ROUND_STEP;
    if (roundTimes) {
      const parsed = parseRoundStep(stepText);
      if (parsed === null) {
        setStepError(true);
        stepRef.current?.focus();
        return;
      }
      roundStep = parsed;
    }
    onExport({ opaqueNames, roundTimes, roundStep, bucketTokens });
  };

  return (
    <dialog
      ref={dialogRef}
      className="export-dialog"
      aria-labelledby={ids.title}
      aria-describedby={ids.contains}
      onCancel={(event) => {
        // Escape: the parent closes it, so the open state stays the parent's.
        event.preventDefault();
        onCancel();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <h2 className="export-title" id={ids.title}>
        {EXPORT_TEXT.title}
      </h2>
      <p id={ids.contains}>{EXPORT_TEXT.contains}</p>
      {live ? <p className="export-live">{EXPORT_TEXT.live}</p> : null}
      <fieldset className="export-options">
        <legend>{EXPORT_TEXT.optionsLegend}</legend>
        <div className="export-option">
          <input
            id={ids.opaque}
            type="checkbox"
            checked={opaqueNames}
            onChange={(event) => setOpaqueNames(event.target.checked)}
            aria-describedby={ids.opaqueHelp}
          />
          <label htmlFor={ids.opaque}>{EXPORT_TEXT.opaqueNames}</label>
          <p className="export-help" id={ids.opaqueHelp}>
            {EXPORT_TEXT.opaqueNamesHelp}
          </p>
        </div>
        <div className="export-option">
          <input
            id={ids.round}
            type="checkbox"
            checked={roundTimes}
            onChange={(event) => {
              setRoundTimes(event.target.checked);
              setStepError(false);
            }}
            aria-describedby={ids.roundHelp}
          />
          <label htmlFor={ids.round}>{EXPORT_TEXT.roundTimes}</label>
          <p className="export-help" id={ids.roundHelp}>
            {EXPORT_TEXT.roundTimesHelp}
          </p>
          <div className="export-step">
            <label htmlFor={ids.step}>{EXPORT_TEXT.roundStep}</label>
            <input
              ref={stepRef}
              id={ids.step}
              type="number"
              inputMode="decimal"
              min={0.001}
              max={3600}
              step={0.001}
              value={stepText}
              disabled={!roundTimes}
              aria-invalid={stepError ? true : undefined}
              aria-describedby={stepError ? ids.stepError : undefined}
              onChange={(event) => {
                setStepText(event.target.value);
                setStepError(false);
              }}
            />
          </div>
          {stepError ? (
            <p className="export-error" id={ids.stepError}>
              {EXPORT_TEXT.badStep}
            </p>
          ) : null}
        </div>
        <div className="export-option">
          <input
            id={ids.bucket}
            type="checkbox"
            checked={bucketTokens}
            onChange={(event) => setBucketTokens(event.target.checked)}
            aria-describedby={ids.bucketHelp}
          />
          <label htmlFor={ids.bucket}>{EXPORT_TEXT.bucketTokens}</label>
          <p className="export-help" id={ids.bucketHelp}>
            {EXPORT_TEXT.bucketTokensHelp}
          </p>
        </div>
      </fieldset>
      <p className="export-note">{EXPORT_TEXT.structure}</p>
      {opaqueNames ? null : <p className="export-note">{EXPORT_TEXT.checkNames}</p>}
      <div className="export-actions">
        <button type="button" onClick={onCancel}>
          {EXPORT_TEXT.cancel}
        </button>
        <button type="button" className="export-confirm" onClick={confirm}>
          {saverKind === "save" ? EXPORT_TEXT.save : EXPORT_TEXT.download}
        </button>
      </div>
    </dialog>
  );
}
