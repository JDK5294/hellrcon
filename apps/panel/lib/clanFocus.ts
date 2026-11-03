/**
 * The clan a jump should open on. A profile's clan tag chip leaves its spelling here and switches
 * to Players → Clans; the tab reads it as it loads and clears it once that clan is on screen.
 *
 * In memory rather than in the URL: the Players address already carries the profile it shows, and
 * a clan is a selection on a tab, not a destination of its own. Read and cleared as two steps so
 * a component mounted twice (React's development double render) still sees it.
 */
let pending: string | null = null;

export function focusClan(tag: string): void { pending = tag; }
export function peekClanFocus(): string | null { return pending; }
export function clearClanFocus(): void { pending = null; }
