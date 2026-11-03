/**
 * Getting started (components/GettingStarted) — the personal setup each person is walked through
 * once: on their first sign-in, or on their next one for everyone who was here before it existed.
 *
 * "Once" is kept like What's new's: on the account, so their other devices skip it too, and on this
 * device, so a save that never reached the account does not bring it back here. The number is the
 * version of the setup they went through; a reworked setup worth seeing again raises it.
 */
export const SETUP_VERSION = 1;

const seenKey = (who: string) => `panel.setupSeen.${who}`;

/** Has this person been through this version of the setup — by their account's word or this device's. */
export function setupSeen(who: string, account: unknown): boolean {
  let here = 0;
  try { here = Number(localStorage.getItem(seenKey(who)) ?? 0) || 0; } catch { /* nothing kept here */ }
  const there = typeof account === "number" ? account : 0;
  return Math.max(here, there) >= SETUP_VERSION;
}

/** Finished or skipped: kept on this device, and the number returned for the account. */
export function markSetupSeen(who: string): number {
  try { localStorage.setItem(seenKey(who), String(SETUP_VERSION)); } catch { /* the account keeps it */ }
  return SETUP_VERSION;
}

/** Open the setup again (Help → Start here): the shell listens (app/page.tsx). */
export function openSetup(): void {
  window.dispatchEvent(new CustomEvent("panel:setup"));
}
