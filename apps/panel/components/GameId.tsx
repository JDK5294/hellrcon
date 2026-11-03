"use client";
/**
 * A player's game id, rendered so it can be taken.
 *
 * These ids are the thing staff carry between systems all day — into a ban appeal, a Discord
 * thread, another admin's DM, the game's own console. Every screen printed them as inert text, so
 * getting one meant selecting a 32-character hex string by hand, which on a phone means a long
 * press and two drag handles and usually one character short.
 *
 * So: click to copy, everywhere, with the same affordance each time. `title` says so on hover, a
 * brief ✓ confirms it landed, and the element stays a `<button>` so a keyboard reaches it too.
 *
 * `truncate` shows a shortened id but ALWAYS copies the whole one — the shortened form exists to
 * fit a table cell, and copying what is on screen rather than what it stands for would be a
 * silent, hard-to-spot wrong answer.
 */
import { useState } from "react";

export function GameId({ id, truncate, className = "" }: {
  id: string | null | undefined;
  /** Show this many leading characters and an ellipsis. Copies the full id regardless. */
  truncate?: number;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!id) return null;

  const shown = truncate && id.length > truncate ? `${id.slice(0, truncate)}…` : id;

  async function copy(e: React.MouseEvent) {
    // Ids sit inside rows that navigate; copying one is not a request to go anywhere.
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(id!);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard denied (insecure origin, or the browser said no) — the id is still on screen */
    }
  }

  return (
    <button
      type="button"
      className={`game-id${copied ? " copied" : ""} ${className}`}
      onClick={copy}
      title={copied ? "Copied" : `${id} — click to copy`}
      aria-label={`Copy id ${id}`}
    >
      <code>{shown}</code>
      <span className="game-id-mark" aria-hidden>{copied ? "✓" : "⧉"}</span>
    </button>
  );
}
