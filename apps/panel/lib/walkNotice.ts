/**
 * New walkthroughs: when someone is given permissions that open walkthroughs they could not follow
 * before, the panel tells them which (components/Walkthroughs NewWalkthroughs), once.
 *
 * What is kept on the account is the walkthroughs that were there but not theirs at the last
 * check, and what that check was made for — their permissions and the build. A walkthrough leaving
 * that list is one their permissions opened. One that is new to the panel itself was never on it,
 * so an update adding walkthroughs tells nobody here: What's new says so, to everyone it is for.
 *
 * The check is made again only when what it was made for changes — a permission given or taken,
 * or an update — so most sign-ins never fetch the walkthroughs at all.
 */
import type { ClientGrant } from "./access.ts";

/** What the account keeps (lib/accountPrefs `walkthroughs`). */
export interface WalkCheck {
  /** What the check was made for (walkCheckKey). */
  for: string;
  /** The walkthroughs there were that this person could not follow. */
  locked: string[];
}

/** What a check is made for: the permissions someone holds themselves — never the wider view an
 *  open request lends — and the build. */
export function walkCheckKey(grants: ClientGrant[], build: number): string {
  const held = grants
    .filter((g) => g.source !== "request-view")
    .map((g) => `${g.capability}:${g.level}:${g.scopeType ?? ""}:${g.scopeId ?? ""}`)
    .sort()
    .join(",");
  let h = 0x811c9dc5;
  for (let i = 0; i < held.length; i++) {
    h ^= held.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${build}.${(h >>> 0).toString(36)}`;
}

/** The walkthroughs newly someone's: ones that were there last time and not theirs, theirs now. */
export function newlyTheirs(before: WalkCheck, mine: string[]): string[] {
  const locked = new Set(before.locked);
  return mine.filter((id) => locked.has(id));
}

/** What to keep for next time: every walkthrough there is that they cannot follow. */
export function lockedNow(all: string[], mine: string[]): string[] {
  const theirs = new Set(mine);
  return all.filter((id) => !theirs.has(id));
}
