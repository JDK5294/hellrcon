"use client";
/**
 * A number box that never shows "012". It keeps what is being typed as text (leading zeros
 * dropped as you go) and hands the number up; when the box loses focus it shows the value the
 * form actually holds — so a clamp ("at least 1") is visible the moment you leave the box.
 * Whole numbers by default; a decimal passes inputMode="decimal" and step="any".
 */
import { useState, type InputHTMLAttributes } from "react";
import { stripLeadingZeros } from "../lib/formNumber";

export function NumField({ value, onValue, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  value: number;
  onValue: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input type="number" inputMode="numeric" {...rest} value={draft ?? String(value)}
      onChange={(e) => { const s = stripLeadingZeros(e.target.value); setDraft(s); onValue(Number(s) || 0); }}
      onBlur={(e) => { setDraft(null); rest.onBlur?.(e); }} />
  );
}
