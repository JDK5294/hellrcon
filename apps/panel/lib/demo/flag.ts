/**
 * Whether this page is the public demo (app/demo): set by lib/demo/install before any of the
 * panel's own code runs, and read by the few parts of the panel that say so.
 */

/** True on the demo; false on the real panel, and while the page is drawn ahead of time. */
export function isDemo(): boolean {
  if (typeof window === "undefined") return false;
  return (window as { __panelDemo?: boolean }).__panelDemo === true;
}

/** Something the demo says in its bar for a moment: a link it kept the visitor from following. */
export const DEMO_NOTE = "panel:demo-note";
