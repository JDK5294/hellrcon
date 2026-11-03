"use client";
/**
 * Feedback layer: toasts + a real confirm dialog.
 *
 * Two things staff need that the panel had no answer for:
 *  - "did that work?" — every action now confirms itself with a toast instead of finishing
 *    silently. Errors stay on screen until dismissed; successes fade.
 *  - "wait, I didn't mean to" — destructive actions ask first, in-app, naming exactly what is
 *    about to happen. Replaces window.confirm (which some browsers suppress, and which looks
 *    like a scam popup to anyone who isn't technical).
 *  - "why didn't that work?" — a button in a list row whose action fails says why in a dialog
 *    with one button. The screen's own error line sits above the list, often a screen or more
 *    away from the row that was pressed, and on a phone the reason was simply missed.
 *
 * Usage:
 *   const toast = useToast();      toast.success("Kicked Bob");   toast.error(err.message);
 *   const confirm = useConfirm();  if (!(await confirm({ title: "Kick Bob?", confirmLabel: "Kick" }))) return;
 *   const alert = useAlert();      alert({ title: "Couldn't remove the ban on Bob", body: err.message });
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Modal } from "../components/ui";
import { ADDED_TO_REQUEST, SENT_FOR_APPROVAL } from "./filed";

type ToastKind = "success" | "error" | "info";
interface Toast { id: number; kind: ToastKind; text: string }

export interface ConfirmOptions {
  title: string;
  /** optional detail line — say what will actually happen, in plain words. */
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** styles the confirm button as destructive (red). */
  danger?: boolean;
}

export interface AlertOptions {
  title: string;
  /** why — the reason the server or the check gave, in its own words. */
  body?: ReactNode;
  okLabel?: string;
}

export interface PromptOptions {
  title: string;
  /** field label — say what to type, not just "Value". */
  label: string;
  initial?: string;
  placeholder?: string;
  /** small help line under the field (where to find the value, what format). */
  hint?: string;
  /** masks input — never send a password through window.prompt, which some password managers
   *  and browsers log or autofill unpredictably. */
  password?: boolean;
  confirmLabel?: string;
  /** false lets an empty answer through (optional notes etc.). Defaults to true. */
  required?: boolean;
}

interface FeedbackApi {
  toast: { success: (text: string) => void; error: (text: string) => void; info: (text: string) => void };
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  /** resolves once the dialog is dismissed. */
  alert: (opts: AlertOptions) => Promise<void>;
  /** resolves to the typed value, or null if cancelled. */
  prompt: (opts: PromptOptions) => Promise<string | null>;
}

const Ctx = createContext<FeedbackApi | null>(null);

/** Toast auto-dismiss. Errors persist — a staff member who looked away must still see failures. */
const DISMISS_MS: Record<ToastKind, number> = { success: 6000, info: 7000, error: 0 };

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [ask, setAsk] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const [askText, setAskText] = useState<(PromptOptions & { resolve: (v: string | null) => void }) | null>(null);
  const [told, setTold] = useState<(AlertOptions & { resolve: () => void }) | null>(null);
  const [draft, setDraft] = useState("");
  const nextId = useRef(1);

  const remove = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const push = useCallback((kind: ToastKind, text: string) => {
    /*
     * "Filed, not done" is news, not a failure.
     *
     * A write that lands as an approval request is raised through the same path as an error,
     * because every screen already has one and none of them would otherwise say anything true.
     * Only the colour would be wrong, and the message is the one thing that reaches this far — so
     * the two notices are recognised by their opening words and shown as information. Sniffing
     * text is not a habit worth spreading; it is done HERE, once, rather than in the ninety-odd
     * call sites that would each have to learn about approvals to say the same sentence.
     */
    if (kind === "error" && (text.startsWith(SENT_FOR_APPROVAL) || text.startsWith(ADDED_TO_REQUEST))) kind = "info";
    const id = nextId.current++;
    setToasts((list) => [...list, { id, kind, text }]);
    const ms = DISMISS_MS[kind];
    if (ms) setTimeout(() => remove(id), ms);
  }, [remove]);

  const api = useMemo<FeedbackApi>(() => ({
    toast: {
      success: (text: string) => push("success", text),
      error: (text: string) => push("error", text),
      info: (text: string) => push("info", text),
    },
    confirm: (opts: ConfirmOptions) => new Promise<boolean>((resolve) => setAsk({ ...opts, resolve })),
    // A second one replaces the first, which counts as dismissed.
    alert: (opts: AlertOptions) => new Promise<void>((resolve) => setTold((prev) => { prev?.resolve(); return { ...opts, resolve }; })),
    prompt: (opts: PromptOptions) => new Promise<string | null>((resolve) => {
      setDraft(opts.initial ?? "");
      setAskText({ ...opts, resolve });
    }),
  }), [push]);

  // Esc cancels the confirm dialog — the expected way out of any modal.
  useEffect(() => {
    const open = ask || askText;
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (ask) { ask.resolve(false); setAsk(null); }
      if (askText) { askText.resolve(null); setAskText(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ask, askText]);

  const settle = (ok: boolean) => { ask?.resolve(ok); setAsk(null); };
  const settleText = (value: string | null) => { askText?.resolve(value); setAskText(null); };
  const settleTold = () => { told?.resolve(); setTold(null); };
  const draftOk = !askText || askText.required === false || draft.trim() !== "";

  return (
    <Ctx.Provider value={api}>
      {children}
      {/* aria-live so screen readers announce results without stealing focus */}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span className="toast-icon" aria-hidden="true">{t.kind === "success" ? "✓" : t.kind === "error" ? "!" : "i"}</span>
            <span className="toast-text">{t.text}</span>
            <button className="toast-x" onClick={() => remove(t.id)} aria-label="Dismiss">×</button>
          </div>
        ))}
      </div>
      {askText && (
        <Modal title={askText.title} onClose={() => settleText(null)} className="confirm-modal">
          <form
            className="pa-fields"
            onSubmit={(e) => { e.preventDefault(); if (draftOk) settleText(draft.trim()); }}
          >
            <label>{askText.label}
              <input
                autoFocus
                type={askText.password ? "password" : "text"}
                value={draft}
                placeholder={askText.placeholder}
                onChange={(e) => setDraft(e.target.value)}
              />
              {askText.hint && <span className="hint">{askText.hint}</span>}
            </label>
            <div className="pa-actions">
              <button type="button" className="ghost" onClick={() => settleText(null)}>Cancel</button>
              <button type="submit" disabled={!draftOk}>{askText.confirmLabel ?? "Save"}</button>
            </div>
          </form>
        </Modal>
      )}
      {told && (
        <Modal title={told.title} onClose={settleTold} className="confirm-modal">
          {told.body && <div className="confirm-body">{told.body}</div>}
          <div className="pa-actions">
            <button autoFocus onClick={settleTold}>{told.okLabel ?? "OK"}</button>
          </div>
        </Modal>
      )}
      {ask && (
        <Modal title={ask.title} onClose={() => settle(false)} className="confirm-modal">
          {ask.body && <div className="confirm-body">{ask.body}</div>}
          <div className="pa-actions">
            <button className="ghost" onClick={() => settle(false)}>{ask.cancelLabel ?? "Cancel"}</button>
            <button className={ask.danger ? "danger" : ""} autoFocus onClick={() => settle(true)}>{ask.confirmLabel ?? "Confirm"}</button>
          </div>
        </Modal>
      )}
    </Ctx.Provider>
  );
}

/** Toasts. Safe outside the provider (no-ops) so components can be rendered in isolation. */
export function useToast(): FeedbackApi["toast"] {
  const ctx = useContext(Ctx);
  return ctx?.toast ?? { success: () => {}, error: () => {}, info: () => {} };
}

/** Ask before doing something irreversible. Falls back to window.confirm outside the provider. */
export function useConfirm(): FeedbackApi["confirm"] {
  const ctx = useContext(Ctx);
  return ctx?.confirm ?? (async (opts) => window.confirm(opts.title));
}

/** Say why an action failed, in a dialog with one button. Falls back to window.alert outside the
 *  provider. */
export function useAlert(): FeedbackApi["alert"] {
  const ctx = useContext(Ctx);
  return ctx?.alert ?? (async (opts) => window.alert(typeof opts.body === "string" ? `${opts.title}\n\n${opts.body}` : opts.title));
}

/** Ask for one value in a styled dialog. Falls back to window.prompt outside the provider. */
export function usePrompt(): FeedbackApi["prompt"] {
  const ctx = useContext(Ctx);
  return ctx?.prompt ?? (async (opts) => window.prompt(opts.label, opts.initial ?? ""));
}
